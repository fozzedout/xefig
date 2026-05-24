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
//   /api/*        -> offline-pack/api/<rest>.json (snapshot from xefig.com)
//   /cdn/*        -> offline-pack/cdn/<rest>     (images pulled from R2)
//   /sw-*.js      -> stubbed empty SW so the bundle's registration call
//                    doesn't 404 (real SW caching is unnecessary when
//                    everything's already on localhost)
//   /*            -> dist-runtime/<rest>          (built web app)
//   404 fallback  -> dist-runtime/index.html      (SPA-style)
//
// Endpoints the snapshot doesn't cover (sync, leaderboard, telemetry,
// contact form) return 204 No Content so the bundle's "fire-and-forget"
// calls don't error out and trigger retries.

const http = require('http')
const fs = require('fs')
const path = require('path')

const DESKTOP_ROOT = path.join(__dirname, '..')
const DIST = path.join(DESKTOP_ROOT, 'dist-runtime')
const PACK = path.join(DESKTOP_ROOT, 'offline-pack')

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

function handleApi(req, res) {
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

  // Otherwise look up offline-pack/api/<rest>.json.
  const apiPath = req.url.slice('/api/'.length)
  const lookup = safeJoin(path.join(PACK, 'api'), apiPath + '.json')
  if (lookup && fs.existsSync(lookup)) {
    return sendFile(lookup, res)
  }
  // Fall back to today.json for any unknown /api/puzzles/<date>.
  // The bundle fetches the actual calendar date (e.g. /api/puzzles/2026-05-23)
  // and our pack only holds the dates we've pulled — so on any new day
  // the request would 404 and the launcher would wedge on "Failed to
  // load today's puzzles". The today.json alias was put there by
  // pull-puzzles.mjs precisely for this; route to it now.
  if (req.url.startsWith('/api/puzzles/')) {
    const todayAlias = path.join(PACK, 'api', 'puzzles', 'today.json')
    if (fs.existsSync(todayAlias)) return sendFile(todayAlias, res)
  }
  send(res, 404, JSON.stringify({ error: 'not in offline pack', path: req.url }), MIME['.json'])
}

function handleCdn(req, res) {
  const lookup = safeJoin(PACK, req.url)
  if (lookup && fs.existsSync(lookup)) {
    return sendFile(lookup, res, CDN_CACHE)
  }
  send(res, 404, 'asset not staged', 'text/plain')
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
    const server = http.createServer((req, res) => {
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
        if (req.url.startsWith('/api/')) return handleApi(req, res)
        if (req.url.startsWith('/cdn/')) return handleCdn(req, res)
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
