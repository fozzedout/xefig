// Admin-panel design check with REAL data.
//
// The admin portal is auth-gated and its data lives on Cloudflare, so `npm run
// dev` renders only an empty shell — which made earlier screenshot checks
// worthless (empty prompts, placeholder images hid real layout problems).
//
// This harness loads the built admin panel, force-unlocks the auth gate, and
// injects REAL fixtures captured from the public puzzle API:
//   - real 4:3 .webp images (full + thumbnail) per category
//   - real (long) theme + tags strings
//   - a realistic ~13-line prompt (what "Regenerate" actually produces)
// so the screenshots reflect production reality.
//
// Refresh fixtures:  apps/web/test-fixtures/admin-design/  (see download cmd in git log)
// Run:               node scripts/admin-design-check.mjs
// Output:            /tmp/admin-design-*.png

import { createRequire } from 'module'
import { readFileSync, readdirSync } from 'fs'
import { createServer } from 'http'
import { extname, join } from 'path'
const require = createRequire('/home/paul/source/xefig/package.json')
const { chromium } = require('playwright')

const WEB = '/home/paul/source/xefig/apps/web'
const DIST = join(WEB, 'dist')
const FIX = join(WEB, 'test-fixtures/admin-design')
const CATS = ['jigsaw', 'slider', 'swap', 'polygram', 'diamond']

// ── fixtures ────────────────────────────────────────────────────────────────
const puzzle = JSON.parse(readFileSync(join(FIX, 'puzzle-2026-06-03.json'), 'utf8')).categories
const toDataUri = (f) => 'data:image/webp;base64,' + readFileSync(join(FIX, f)).toString('base64')
const fulls = Object.fromEntries(CATS.map((c) => [c, toDataUri(`${c}.webp`)]))
const thumbs = Object.fromEntries(CATS.map((c) => [c, toDataUri(`${c}_thumb.webp`)]))
const meta = Object.fromEntries(CATS.map((c) => [c, { theme: puzzle[c].theme, tags: puzzle[c].tags.join(', ') }]))
// A realistic ~13-line generated prompt (what Regenerate emits).
const PROMPT13 = `A sun-soaked moonlit vault kitchen garden rendered as a premium gallery-quality scene, teal and amber dominant tones with natural colour variation throughout.
Weathered stone vault arches frame raised herb beds, trailing vines and terracotta pots catching a starlit twilight gradient overhead.
A balcony perspective looks outward across the garden toward a low horizon, layered foreground, middle ground and background each carrying their own distinct detail.
Climbing roses and lavender rows thread between flagstone paths; a quiet stream catches glints of amber lantern light.
Every region is packed with rich texture, fine surface detail and tonal depth, with many distinct recognisable sub-regions and clear visual separation.
Secondary and environmental colours remain visible beneath the dominant palette so the image reads as layered, not flat.
The mood is sun-soaked and lazy, hushed and contemplative, with a languid golden warmth pooling in the lower third.
Soft volumetric light filters through the vault openings, dust motes suspended in the beams.
No text, titles, labels, watermarks, signatures or lettering of any kind.
Single landscape 4:3 image, composition extending to every edge so it fills the full frame.
Painterly, detailed-but-flat, colour-blocked, cel-shaded aesthetic with strong silhouettes.
Cohesive depth and atmosphere, gallery-quality finish, balanced composition.
Deliver one image only.`

// ── static server for dist/ ─────────────────────────────────────────────────
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.ico': 'image/x-icon' }
// Point at a live URL (e.g. ADMIN_URL=https://xefig.com/admin-panel) to check
// PROD after a deploy; otherwise serve the local dist/ build.
const ADMIN_URL = process.env.ADMIN_URL
const TAG = process.env.TAG || (ADMIN_URL ? 'prod' : 'local')
let server = null
if (!ADMIN_URL) {
  server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p === '/') p = '/admin-panel.html'
    try {
      const body = readFileSync(join(DIST, p))
      res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404); res.end('nf') }
  })
  await new Promise((r) => server.listen(8137, r))
}
const TARGET = ADMIN_URL || 'http://localhost:8137/admin-panel.html'

// ── drive the page ───────────────────────────────────────────────────────────
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1900, height: 1000 }, deviceScaleFactor: 1 })
const page = await ctx.newPage()
await page.goto(TARGET, { waitUntil: 'load' })
await page.waitForTimeout(800)

await page.evaluate(async ({ cats, fulls, thumbs, meta, prompt }) => {
  const g = document.getElementById('auth-gate'); if (g) g.hidden = true
  document.getElementById('app-content').dataset.locked = 'false'
  document.getElementById('record-badge')?.setAttribute('data-state', 'live')

  const drawTo = (canvas, uri) => new Promise((resolve) => {
    const im = new Image()
    im.onload = () => { canvas.width = 320; canvas.height = 240; canvas.getContext('2d').drawImage(im, 0, 0, 320, 240); resolve() }
    im.onerror = resolve
    im.src = uri
  })

  for (const c of cats) {
    const full = document.getElementById(`thumb-${c}`)
    if (full) { full.hidden = false; const i = full.querySelector('img'); if (i) i.src = fulls[c] }
    const thumb = document.getElementById(`thumbnail-${c}`)
    if (thumb) {
      thumb.hidden = false
      const img = thumb.querySelector('img'); if (img) img.src = thumbs[c]
      const cv = thumb.querySelector('canvas'); if (cv) await drawTo(cv, fulls[c])
    }
    const th = document.getElementById(`theme-${c}`); if (th) th.value = meta[c].theme
    const tg = document.getElementById(`tags-${c}`); if (tg) tg.value = meta[c].tags
    const pr = document.getElementById(`prompt-${c}`); if (pr) pr.value = prompt
  }
  // Lab tuned preview + a representative metrics readout
  const lp = document.getElementById('diamond-lab-preview')
  if (lp) { lp.hidden = false; await drawTo(document.getElementById('diamond-lab-canvas'), fulls.diamond) }
  const r = document.getElementById('diamond-complexity-result')
  if (r) {
    r.hidden = false
    r.innerHTML =
      ['edges 35%','regions 713','largest 8%','isolated 0','colors 24','reg/color 29.7','small≤16 17%','big65+ 62%','minΔ 49']
        .map(t => `<span class="complexity-metric">${t}</span>`).join('') +
      '<span class="complexity-verdict" data-state="borderline">borderline</span>' +
      '<div class="region-size-chart">' +
      [['1',0,0],['2-4',377,7],['5-16',149,7],['17-64',81,9],['65+',71,23],['101-500',32,38],['501+',3,17]]
        .map(([lab,n,pct]) => `<div class="region-size-bucket"><span class="region-size-count">${n}</span><div class="region-size-bar" style="height:${Math.max(2, pct*3)}px"></div><span class="region-size-label">${lab}</span></div>`).join('') +
      '</div>'
  }
}, { cats: CATS, fulls, thumbs, meta, prompt: PROMPT13 })

await page.waitForTimeout(700)

const shoot = async (name) => { await page.screenshot({ path: `/tmp/admin-design-${TAG}-${name}.png`, fullPage: true }); console.log('shot', TAG, name) }

// Review with prompts collapsed (default state)
await page.locator('.page-nav-btn[data-page="editor"]').click(); await page.waitForTimeout(150)
await shoot('review-1900')
const rows = await page.evaluate(() => [...document.querySelectorAll('#page-editor .category-card')].map(c => ({ mode: c.dataset.mode, h: Math.round(c.getBoundingClientRect().height) })))
console.log('ROW HEIGHTS (collapsed):', JSON.stringify(rows))
// One prompt expanded → verify the 13-line textarea
await page.evaluate(() => { document.querySelector('#page-editor .category-card[data-mode="jigsaw"] details.prompt-detail')?.setAttribute('open', '') })
await page.waitForTimeout(150)
await shoot('review-prompt-open')
// Narrow
await page.setViewportSize({ width: 760, height: 1000 }); await page.waitForTimeout(200)
await shoot('review-760')
await page.setViewportSize({ width: 1900, height: 1000 }); await page.waitForTimeout(150)
// Lab
await page.locator('.page-nav-btn[data-page="lab"]').click(); await page.waitForTimeout(200)
await shoot('lab-1900')

await browser.close()
if (server) server.close()
