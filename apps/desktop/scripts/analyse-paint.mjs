// Read every diamond paint session log under apps/desktop/session-logs/
// and surface the metrics that correlate with "good demo image":
//
//   - Total active time (clock that ran while the player was actively
//     painting; excludes idle pauses)
//   - Fill count, wrong-fill count, ratio
//   - Colour-switch count + median dwell-time per colour (long dwells
//     = the player parked on one colour and worked it)
//   - Per-colour cells painted vs. wrong-fills (which colours
//     frustrated them?)
//   - Static grid stats from gridStats: total regions, mean/median
//     region size, largest region, count of singleton-ish regions
//   - Throughput: cells/sec, fills/min
//
// Usage:
//   node scripts/analyse-paint.mjs               # all logs
//   node scripts/analyse-paint.mjs latest        # most recent only
//   node scripts/analyse-paint.mjs <file>...     # specific files

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(here, '..', 'session-logs')

function pickFiles() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    return readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(LOG_DIR, f))
  }
  if (args.length === 1 && args[0] === 'latest') {
    const all = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
    return all.length ? [join(LOG_DIR, all[all.length - 1])] : []
  }
  return args.map((a) => (a.includes('/') ? a : join(LOG_DIR, a)))
}

function median(arr) {
  if (!arr.length) return null
  const sorted = [...arr].sort((a, b) => a - b)
  const m = sorted.length >> 1
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = (s - m * 60).toFixed(0)
  return `${m}:${rs.padStart(2, '0')}`
}

function analyse(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const log = raw.log || raw
  const events = log.events || []
  const grid = log.gridStats || {}

  // Iterate events: tally selects (s), fills (f), wrong fills (w).
  const fills = []
  const wrongs = []
  const selects = []
  const cellsPerColor = {}
  const wrongsPerColor = {}
  let lastSelectTs = null
  const dwellTimes = []

  for (const e of events) {
    if (e.k === 's') {
      selects.push(e)
      if (lastSelectTs != null) dwellTimes.push(e.t - lastSelectTs)
      lastSelectTs = e.t
    } else if (e.k === 'f') {
      fills.push(e)
      cellsPerColor[e.c] = (cellsPerColor[e.c] || 0) + (e.n || 1)
    } else if (e.k === 'w') {
      wrongs.push(e)
      wrongsPerColor[e.c] = (wrongsPerColor[e.c] || 0) + 1
    }
  }

  const lastEventTs = events.length ? events[events.length - 1].t : 0
  const totalCells = Object.values(cellsPerColor).reduce((a, b) => a + b, 0)
  const totalElapsed = raw.elapsedActiveMs ?? lastEventTs

  // Top frustration colours = highest wrong-fill counts.
  const frustration = Object.entries(wrongsPerColor)
    .map(([c, n]) => ({ color: Number(c), wrongs: n, cells: cellsPerColor[c] || 0 }))
    .sort((a, b) => b.wrongs - a.wrongs)
    .slice(0, 5)

  return {
    file: basename(file),
    elapsed: totalElapsed,
    activeElapsed: raw.elapsedActiveMs,
    cols: log.cols,
    rows: log.rows,
    paletteSize: log.paletteSize,
    events: events.length,
    fills: fills.length,
    wrongs: wrongs.length,
    wrongRate: fills.length + wrongs.length > 0 ? wrongs.length / (fills.length + wrongs.length) : 0,
    selects: selects.length,
    medianDwell: median(dwellTimes),
    totalCells,
    cellsPerFill: fills.length ? totalCells / fills.length : 0,
    fillsPerMin: totalElapsed > 0 ? (fills.length / (totalElapsed / 1000 / 60)) : 0,
    grid: {
      regionCount: grid.regionCount,
      largestRegion: grid.largestRegionSize,
      largestFraction: grid.largestRegionFraction,
      meanRegionsPerActiveColor: grid.meanRegionsPerActiveColor,
      isolatedCount: grid.isolatedCount,
      adjacencyDiffRate: grid.adjacencyDiffRate,
    },
    frustration,
  }
}

const files = pickFiles()
if (!files.length) {
  console.log('No session logs to analyse. Play a diamond paint puzzle from the harness first.')
  process.exit(0)
}

for (const f of files) {
  try {
    const r = analyse(f)
    console.log(`\n== ${r.file} ==`)
    console.log(`  Time:           ${fmtMs(r.elapsed)} (active: ${fmtMs(r.activeElapsed)})`)
    console.log(`  Grid:           ${r.cols}×${r.rows} (${r.cols * r.rows} cells, palette ${r.paletteSize})`)
    console.log(`  Regions:        ${r.grid.regionCount}, largest = ${r.grid.largestRegion} (${(r.grid.largestFraction * 100).toFixed(1)}%)`)
    console.log(`  Per-colour:     mean ${r.grid.meanRegionsPerActiveColor?.toFixed(1)} regions/colour, ${r.grid.isolatedCount} isolated singletons`)
    console.log(`  Adjacency:      ${(r.grid.adjacencyDiffRate * 100).toFixed(1)}% of cell pairs differ in colour (lower = chunkier = faster solve)`)
    console.log(`  Fills:          ${r.fills} (mean ${r.cellsPerFill.toFixed(0)} cells per tap, ${r.fillsPerMin.toFixed(1)} fills/min)`)
    console.log(`  Wrong taps:     ${r.wrongs} (${(r.wrongRate * 100).toFixed(1)}% of all taps)`)
    console.log(`  Colour switches: ${r.selects} (median ${fmtMs(r.medianDwell)} on each colour before switching)`)
    if (r.frustration.length) {
      console.log(`  Most-mistaken colours:`)
      for (const f of r.frustration) {
        console.log(`    #${f.color + 1}: ${f.wrongs} wrong taps over ${f.cells} cells`)
      }
    }
  } catch (err) {
    console.error(`Failed to analyse ${f}:`, err.message)
  }
}

console.log('\n--- What to look for ---')
console.log('Fast image: low regionCount, high largestFraction, low isolatedCount, low adjacencyDiffRate.')
console.log('Frustrating image: high wrong-rate (>10%) and high "most-mistaken" counts on similar-shade colours.')
console.log('Tedious-but-not-hard image: high fills count with low cells-per-fill (lots of tiny isolated regions).')
