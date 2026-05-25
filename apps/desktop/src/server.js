// Embedded HTTP server for the desktop client.
//
// Loading the web bundle via file:// breaks half of what the renderer
// expects to work — service workers won't register, fetch() to relative
// /api/* paths resolves to nowhere, and the bundle's "Loading..." screen
// waits forever. Spinning up a tiny http.createServer on localhost
// solves all of that in one go: same-origin requests work, SW registers,
// caches behave normally.
//
// Routes (in order of precedence per request):
//   /api/puzzles/* -> offline-pack first; on a miss, proxy the live
//                     origin (XEFIG_API, default xefig.com) and stage
//                     the result into the pack. This is what lets the
//                     desktop client play the full daily archive online
//                     without a pre-pulled snapshot — and replay it
//                     offline afterwards. Offline/down: falls back to
//                     the today.json alias so the launcher never wedges.
//   /api/*         -> offline-pack/api/<rest>.json (snapshot)
//   /cdn/*         -> offline-pack first; on a miss, proxy + stage from
//                     the live CDN, same as puzzles.
//   /sw-*.js      -> stubbed empty SW so the bundle's registration call
//                    doesn't 404 (real SW caching is unnecessary when
//                    everything's already on localhost)
//   /*            -> dist-runtime/<rest>          (built web app)
//   404 fallback  -> dist-runtime/index.html      (SPA-style)
//
// Endpoints we deliberately don't proxy yet (sync, leaderboard, telemetry,
// contact form) return 204 No Content so the bundle's "fire-and-forget"
// calls don't error out and trigger retries.

const http = require('http')
const fs = require('fs')
const path = require('path')

const DESKTOP_ROOT = path.join(__dirname, '..')
const DIST = path.join(DESKTOP_ROOT, 'dist-runtime')
const PACK = path.join(DESKTOP_ROOT, 'offline-pack')

// Live origin to proxy pack-misses against. Mirrors pull-puzzles.mjs's
// override (XEFIG_API / API) so a beta origin can be targeted the same
// way. Pack-resident content never touches this — only misses do.
const API = (process.env.XEFIG_API || process.env.API || 'https://xefig.com').replace(/\/+$/, '')

// Bespoke curated content (the paid layer's hand-made themed areas).
// Committed with the build, not gitignored like offline-pack/ — and
// never proxied. A demo area points its puzzleDate at a curated id and
// CURATED/<id>/puzzle.json shadows the daily pack/proxy for that id.
const CURATED = path.join(DESKTOP_ROOT, 'curated')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

// Endpoints the bundle calls that we don't (yet) need to mock with real
// data. Returning 204 lets the bundle's promises resolve without errors.
// Order matters — prefix match, first hit wins.
const NOOP_API_PREFIXES = [
  '/api/sync/',
  '/api/leaderboard/',
  '/api/contact',
]

// Diamond paint logs are too useful to drop on the floor during the
// demo timing run — they're the only data we have on per-image solve
// behaviour. Stash each POST in apps/desktop/session-logs/ so
// scripts/analyse-paint.mjs can correlate them against the puzzle
// they were played from.
const SESSION_LOG_DIR = path.join(__dirname, '..', 'session-logs')

function mimeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

function send(res, status, body, contentType, cacheHeader) {
  res.writeHead(status, {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': cacheHeader || 'no-store',
  })
  res.end(body)
}

function sendFile(filePath, res, cacheHeader) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found', 'text/plain')
    send(res, 200, data, mimeFor(filePath), cacheHeader)
  })
}

// Proxy a pack-miss to the live origin, stream it back to the renderer,
// and stage it into offline-pack/ on the way through — the runtime
// equivalent of scripts/pull-puzzles.mjs. The first online play of any
// archive day or asset therefore makes it offline-replayable forever.
// Throws on any network/upstream failure so the caller can run its own
// fallback (today.json alias for puzzles, 404 for assets).
async function proxyAndCache({ res, upstreamPath, cacheFile, contentType, cacheHeader }) {
  const url = `${API}${upstreamPath}`
  process.stderr.write(`[server] proxy -> ${url}\n`)
  const upstream = await fetch(url)
  if (!upstream.ok) throw new Error(`upstream ${upstream.status}`)
  const buf = Buffer.from(await upstream.arrayBuffer())
  // Stage before responding so the bytes we serve are exactly the bytes
  // we persisted. A write failure (read-only install dir, full disk) is
  // non-fatal — we still serve the freshly fetched copy this session.
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, buf)
  } catch (err) {
    process.stderr.write(`[server] cache write failed for ${cacheFile}: ${err.message}\n`)
  }
  send(res, 200, buf, contentType, cacheHeader)
}

// Cache /cdn assets aggressively in the browser — the bundle's puzzle
// JSON carries a ?v=<timestamp> on every image URL that already busts
// on regeneration, so the browser-cached copy is always content-true.
// Without this, the inject-end shim's img.src reassignment on every
// DOM mutation costs a real network round-trip per redraw.
const CDN_CACHE = 'public, max-age=31536000, immutable'

// Strip query string + leading slash so we don't get tripped up by the
// ?v=cachebust suffix the API attaches to image URLs.
function cleanPath(urlPath) {
  return urlPath.split('?')[0].replace(/^\/+/, '')
}

function safeJoin(root, urlPath) {
  const clean = cleanPath(urlPath)
  const target = path.resolve(root, clean)
  // Prevent ../ traversal out of the served roots.
  if (!target.startsWith(root)) return null
  return target
}

function captureDiamondLog(req, res) {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8')
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const isTest = req.url.includes('/test-session-log') ? '-test' : ''
      const out = path.join(SESSION_LOG_DIR, `${ts}${isTest}.json`)
      fs.mkdirSync(SESSION_LOG_DIR, { recursive: true })
      fs.writeFileSync(out, body)
      process.stderr.write(`[server] saved diamond log -> ${out}\n`)
    } catch (err) {
      process.stderr.write(`[server] diamond log save failed: ${err.message}\n`)
    }
    res.writeHead(204).end()
  })
}

async function handleApi(req, res) {
  // Capture diamond paint telemetry to local files for the demo
  // timing analysis. Same 204 behaviour the bundle expects; the body
  // just lands on disk instead of disappearing.
  if (req.method === 'POST' && (req.url.startsWith('/api/diamond/session-log') || req.url.startsWith('/api/diamond/test-session-log'))) {
    return captureDiamondLog(req, res)
  }

  // No-op shortcuts for endpoints we deliberately don't snapshot.
  for (const prefix of NOOP_API_PREFIXES) {
    if (req.url.startsWith(prefix)) {
      res.writeHead(204).end()
      return
    }
  }

  const apiPath = req.url.slice('/api/'.length)

  // Curated content shadows everything. When a demo area points its
  // puzzleDate at a curated id, CURATED/<id>/puzzle.json wins over the
  // daily pack/proxy — this is the path hand-made themed artwork drops
  // into, decoupled from the daily LLM dates. (Authored via
  // scripts/build-curated.mjs.)
  if (req.url.startsWith('/api/puzzles/')) {
    const id = cleanPath(req.url.slice('/api/puzzles/'.length))
    const curatedJson = safeJoin(CURATED, `${id}/puzzle.json`)
    if (curatedJson && fs.existsSync(curatedJson)) return sendFile(curatedJson, res)
  }

  // Otherwise look up offline-pack/api/<rest>.json.
  const lookup = safeJoin(path.join(PACK, 'api'), apiPath + '.json')
  if (lookup && fs.existsSync(lookup)) {
    return sendFile(lookup, res)
  }

  // Pack miss on a puzzle date: proxy the live origin and stage the
  // result. This is what lets the desktop client play the full daily
  // archive (and any not-yet-pulled day) without a pre-staged pack —
  // the free online layer the Steam demo hands out. `lookup` is already
  // the right on-disk target (offline-pack/api/puzzles/<date>.json).
  if (lookup && req.url.startsWith('/api/puzzles/')) {
    try {
      await proxyAndCache({ res, upstreamPath: '/api/' + cleanPath(apiPath), cacheFile: lookup, contentType: MIME['.json'] })
      return
    } catch (err) {
      // Offline or upstream down. Fall back to today.json — the newest
      // pulled day — so the launcher always has something to show
      // rather than wedging on "Failed to load today's puzzles".
      process.stderr.write(`[server] puzzle proxy failed (${err.message}); falling back to today.json\n`)
      const todayAlias = path.join(PACK, 'api', 'puzzles', 'today.json')
      if (fs.existsSync(todayAlias)) return sendFile(todayAlias, res)
    }
  }
  send(res, 404, JSON.stringify({ error: 'not in offline pack', path: req.url }), MIME['.json'])
}

async function handleCdn(req, res) {
  // Curated assets live alongside their manifest in apps/desktop/curated/,
  // committed with the build and never proxied. /cdn/curated/<id>/<file>
  // maps straight onto curated/<id>/<file>.
  if (req.url.startsWith('/cdn/curated/')) {
    const rel = cleanPath(req.url).slice('cdn/'.length) // "curated/<id>/<file>"
    const target = safeJoin(DESKTOP_ROOT, rel)
    if (target && fs.existsSync(target)) return sendFile(target, res, CDN_CACHE)
    return send(res, 404, 'curated asset missing', 'text/plain')
  }

  const lookup = safeJoin(PACK, req.url)
  if (!lookup) return send(res, 400, 'bad path', 'text/plain')
  if (fs.existsSync(lookup)) {
    return sendFile(lookup, res, CDN_CACHE)
  }
  // Pack miss: proxy the asset from the live CDN and stage it under the
  // same path. cleanPath strips the ?v= cachebust so the on-disk name is
  // stable across redraws; `lookup` is the resolved, traversal-checked
  // write target.
  try {
    await proxyAndCache({ res, upstreamPath: '/' + cleanPath(req.url), cacheFile: lookup, contentType: mimeFor(lookup), cacheHeader: CDN_CACHE })
  } catch (err) {
    process.stderr.write(`[server] cdn proxy failed for ${req.url}: ${err.message}\n`)
    send(res, 404, 'asset not staged', 'text/plain')
  }
}

function handleStatic(req, res) {
  const target = safeJoin(DIST, req.url)
  if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
    return sendFile(target, res)
  }
  // SPA fallback so deep links land on index.html.
  sendFile(path.join(DIST, 'index.html'), res)
}

// Files in apps/desktop/src/ that the harness serves to the renderer.
// They live next to this module rather than in dist-runtime/ so they're
// edited directly without a web-build round-trip.
const SRC = __dirname
const DESKTOP = path.join(__dirname, '..')
const DEMO_CONFIG = path.join(DESKTOP, 'demo-config.json')

// Serve a small allowlist of files from apps/desktop/ — the demo
// harness page, the demo config JSON, etc. Returns true if the
// request was handled here so the main router can short-circuit;
// false otherwise.
function handleDesktopAsset(req, res) {
  const map = {
    '/hub': path.join(SRC, 'world.html'),
    '/hub.html': path.join(SRC, 'world.html'),
    '/world': path.join(SRC, 'world.html'),
    '/world.html': path.join(SRC, 'world.html'),
    '/demo-harness': path.join(SRC, 'demo-harness.html'),
    '/demo-harness.html': path.join(SRC, 'demo-harness.html'),
    '/demo-config.json': DEMO_CONFIG,
    '/paint-preview': path.join(SRC, 'paint-preview.html'),
    '/paint-preview.html': path.join(SRC, 'paint-preview.html'),
  }
  const target = map[req.url.split('?')[0]]
  if (target && fs.existsSync(target)) {
    sendFile(target, res)
    return true
  }
  return false
}

function start() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      // Log every request through nw.js's stderr so we can grep
      // launch logs for "request not in pack" symptoms without
      // attaching a debugger.
      const origWrite = res.writeHead.bind(res)
      res.writeHead = (status, ...rest) => {
        process.stderr.write(`[server] ${status} ${req.method} ${req.url}\n`)
        return origWrite(status, ...rest)
      }
      try {
        if (handleDesktopAsset(req, res)) return
        if (req.url.startsWith('/api/')) return await handleApi(req, res)
        if (req.url.startsWith('/cdn/')) return await handleCdn(req, res)
        return handleStatic(req, res)
      } catch (err) {
        send(res, 500, String(err), 'text/plain')
      }
    })
    server.on('error', (err) => console.error('[server] error', err))
    // Pin to a fixed port so localStorage persists across nw restarts.
    // localStorage is scoped per origin (scheme://host:port) — a random
    // port means each launch is a different origin and previous play
    // sessions vanish. PORT env var overrides; falls back to a random
    // port if the fixed one is busy (rare in practice).
    const preferred = Number(process.env.PORT) || 7321
    server.listen(preferred, '127.0.0.1', (err) => {
      if (err) {
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port
          resolve({ url: `http://127.0.0.1:${port}/`, port, server })
        })
      } else {
        const port = server.address().port
        resolve({ url: `http://127.0.0.1:${port}/`, port, server })
      }
    })
  })
}

module.exports = { start }
