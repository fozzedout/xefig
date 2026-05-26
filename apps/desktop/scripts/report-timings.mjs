// Report the timing-harness captures (session-logs/timings.jsonl, written
// by the embedded server when a puzzle completes during a harness session)
// grouped by demo area, with each area's total against its demo-config
// estimatedMinutes goal.
//
//   node scripts/report-timings.mjs
//
// Re-runs overwrite: the latest capture per (date, mode) wins, so just
// replay a puzzle to update its time.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const LOG = join(here, '..', 'session-logs', 'timings.jsonl')
const CONFIG = join(here, '..', 'demo-config.json')

const MODE_ORDER = ['jigsaw', 'sliding', 'swap', 'polygram', 'diamond']

function fmt(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '   — '
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

if (!existsSync(LOG)) {
  console.error(`No timings yet at ${LOG}\nRun the harness (XEFIG_DEMO_HARNESS=1) and complete some puzzles first.`)
  process.exit(1)
}

// Latest elapsedMs per date+mode.
const byDate = {}
for (const raw of readFileSync(LOG, 'utf8').split('\n')) {
  const line = raw.trim()
  if (!line) continue
  let rec
  try { rec = JSON.parse(line) } catch { continue }
  if (!rec.date || !rec.mode) continue
  ;(byDate[rec.date] ||= {})[rec.mode] = rec.elapsedMs // later line wins
}

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
const areaByDate = {}
for (const a of cfg.areas || []) areaByDate[a.puzzleDate] = a

const dates = Object.keys(byDate).sort()
if (!dates.length) { console.log('No usable timing records.'); process.exit(0) }

for (const date of dates) {
  const area = areaByDate[date]
  const title = area ? `${area.title} (${area.subtitle || ''})`.trim() : 'Unknown area'
  console.log(`\n${title} — ${date}`)
  let total = 0
  for (const mode of MODE_ORDER) {
    const ms = byDate[date][mode]
    if (ms == null) { console.log(`  ${mode.padEnd(9)} ${'—'.padStart(6)}  (not played)`); continue }
    total += ms
    console.log(`  ${mode.padEnd(9)} ${fmt(ms).padStart(6)}`)
  }
  console.log(`  ${''.padEnd(9)} ${'------'.padStart(6)}`)
  const goalMin = area?.estimatedMinutes
  if (Number.isFinite(goalMin)) {
    const goalMs = goalMin * 60000
    const delta = total - goalMs
    const sign = delta >= 0 ? '+' : '-'
    console.log(`  ${'total'.padEnd(9)} ${fmt(total).padStart(6)}   goal ${fmt(goalMs)}  (${sign}${fmt(Math.abs(delta)).trim()})`)
  } else {
    console.log(`  ${'total'.padEnd(9)} ${fmt(total).padStart(6)}   (no goal in demo-config)`)
  }
}
console.log('')
