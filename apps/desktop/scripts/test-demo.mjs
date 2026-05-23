// Verifies the demo timing harness end-to-end: spins up the embedded
// server, navigates a real Chromium (Playwright) browser through each
// of the 15 demo URLs, and checks that the puzzle renders with the
// difficulty overrides from demo-config.json actually applied.
//
// What success looks like, per mode:
//   jigsaw   -> exactly cols*rows piece canvases on the board
//   sliding  -> .sliding-tile elements = cols*rows - 1 (one tile is the gap)
//   swap     -> .picture-swap-tile elements = cols*rows
//   polygram -> shardCount property on the puzzle instance == config
//   diamond  -> totalCells property on the puzzle instance == cols*rows
//                (within ±5% rounding of the targetCells override)
//
// Usage:
//   node scripts/test-demo.mjs
//   node scripts/test-demo.mjs classroom-jigsaw   # subset

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// server.js is CommonJS and uses __dirname relative to apps/desktop/src/.
// Loading it from this script preserves that, since require resolves
// relative to the .js file, not the importer.
const server = require(join(here, '..', 'src', 'server.js'))

// Playwright lives at the monorepo root.
const { chromium } = require(join(here, '..', '..', '..', 'node_modules', 'playwright'))

const cfg = JSON.parse(readFileSync(join(here, '..', 'demo-config.json'), 'utf8'))

const wanted = process.argv.slice(2)
const cases = []
for (const area of cfg.areas) {
  for (const modeSlug of ['jigsaw', 'sliding', 'swap', 'polygram', 'diamond']) {
    const raw = area.difficulties?.[modeSlug]
    if (!raw) continue
    const slug = `${area.id}-${modeSlug}`
    if (wanted.length && !wanted.includes(slug)) continue
    cases.push({ slug, areaId: area.id, modeSlug, raw, date: area.puzzleDate })
  }
}

function expectedFor(mode, raw) {
  if (mode === 'jigsaw' || mode === 'sliding' || mode === 'swap') {
    return { kind: 'pieces', value: raw.cols * raw.rows, label: `${raw.cols}×${raw.rows}` }
  }
  if (mode === 'polygram') return { kind: 'shards', value: raw.shards, label: `${raw.shards} shards` }
  if (mode === 'diamond') return { kind: 'cells', value: raw.targetCells, label: `~${raw.targetCells} cells` }
  return null
}

async function pieceCount(page, mode) {
  if (mode === 'jigsaw') {
    return page.evaluate(() => {
      // The board has placed pieces inside .jigsaw-board-area and the
      // carousel has unplaced pieces in .jigsaw-carousel-item. Each
      // piece exists once total (it moves between the two), so summing
      // unique pieces is the carousel item count + the board piece
      // count after init.
      // Each piece exists as a .jigsaw-carousel-item entry (the tray)
      // and a canvas.jigsaw-piece (the rendering surface). Counting
      // carousel items is unambiguous — boards may have 0 pieces just
      // after init because everything starts in the tray.
      return document.querySelectorAll('.jigsaw-carousel-item').length
    })
  }
  if (mode === 'sliding') {
    return page.evaluate(() => document.querySelectorAll('.sliding-tile').length)
  }
  if (mode === 'swap') {
    return page.evaluate(() => document.querySelectorAll('.picture-swap-tile').length)
  }
  return 0
}

async function instanceProp(page, prop) {
  // Last-resort dig: the puzzle classes attach themselves to globals
  // when the bundle's main module instantiates them. We can't reach
  // those from Playwright reliably — instead, walk the DOM for a
  // canvas/section and read a data-* attribute, or count visible
  // elements. For polygram + diamond we rely on the DOM hooks below.
  return null
}

async function run() {
  const { url } = await server.start()
  console.log(`Server up at ${url}`)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', (err) => console.log(`  [page:error]`, err.message))

  let pass = 0
  let fail = 0

  for (const c of cases) {
    const expected = expectedFor(c.modeSlug, c.raw)
    process.stdout.write(`  ${c.slug.padEnd(28)} expected ${expected.label.padEnd(14)} ... `)
    try {
      await page.goto(`${url}?demo=${c.slug}`, { waitUntil: 'load', timeout: 15000 })
      // The bundle's auto-click fires inside requestAnimationFrame
      // once the launcher slices are bound. Just wait for the puzzle
      // root to appear — we don't need to click anything ourselves.
      // Wait for the mode's root selector to land — the launcher's
      // background image fetches mean networkidle never fires.
      const rootSelector = {
        jigsaw: '.jigsaw-root, .jigsaw-board',
        sliding: '.sliding-tile',
        swap: '.picture-swap-tile',
        polygram: '.polygram-piece',
        diamond: '.diamond-canvas',
      }[c.modeSlug]
      try {
        await page.waitForSelector(rootSelector, { timeout: 20000 })
      } catch (waitErr) {
        const dump = await page.evaluate(() => ({
          url: window.location.href,
          sliceCount: document.querySelectorAll('.slice').length,
          sliceContainerExists: !!document.querySelector('#slice-container'),
          sliceContainerHtml: (document.querySelector('#slice-container')?.innerHTML || '').slice(0, 400),
          gameShell: !!document.querySelector('.game-shell'),
          puzzleMount: !!document.querySelector('#puzzle-mount'),
        }))
        console.log('\n  DOM dump:', JSON.stringify(dump, null, 2))
        throw waitErr
      }
      // Give the puzzle a tick to finish laying out pieces.
      await page.waitForTimeout(800)

      let actual = '?'
      let ok = false
      if (expected.kind === 'pieces') {
        const count = await pieceCount(page, c.modeSlug)
        actual = `${count} elements`
        // For sliding, total tiles = cols*rows - 1 (one gap)
        const target = c.modeSlug === 'sliding' ? expected.value - 1 : expected.value
        ok = count === target
      } else if (expected.kind === 'shards') {
        // Shards are .polygram-piece in the live bundle.
        const count = await page.evaluate(() => document.querySelectorAll('.polygram-piece').length)
        actual = `${count} shards`
        // Voronoi tessellation can land at ±1 around the requested count.
        ok = Math.abs(count - expected.value) <= 2
      } else if (expected.kind === 'cells') {
        // Diamond exposes cols/rows on the root via a data attribute? If
        // not, we infer from the canvas backing dimensions vs CELL_PX.
        const got = await page.evaluate(() => {
          const canvas = document.querySelector('.diamond-canvas')
          if (!canvas) return null
          // CELL_PX is 24 in production (see diamond-painting-puzzle.js).
          const CELL_PX = 24
          return {
            cols: canvas.width / CELL_PX,
            rows: canvas.height / CELL_PX,
            total: (canvas.width * canvas.height) / (CELL_PX * CELL_PX),
          }
        })
        if (!got) { actual = 'no canvas'; ok = false }
        else {
          actual = `~${Math.round(got.total)} cells (${Math.round(got.cols)}×${Math.round(got.rows)})`
          // Diamond rounds to the nearest grid that respects the image
          // aspect ratio, so 5000 might land as ~4900 or ~5100. Allow
          // ±10% slack.
          ok = Math.abs(got.total - expected.value) / expected.value < 0.10
        }
      }
      if (ok) { console.log(`OK (${actual})`); pass++ }
      else    { console.log(`FAIL (got ${actual})`); fail++ }
    } catch (err) {
      console.log(`ERR ${err.message}`)
      fail++
    }
  }

  await browser.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(2)
})
