#!/usr/bin/env node

import { getSummary, getFailures } from './db.js'

const summary = getSummary()

if (summary.length === 0) {
  console.log('No audit results yet. Run: node src/audit.js')
  process.exit(0)
}

console.log('Audit status:')
for (const row of summary) {
  console.log(`  ${row.status}: ${row.count}`)
}

const failures = getFailures()
if (failures.length > 0) {
  console.log(`\nFailed images (${failures.length}):`)
  for (const f of failures) {
    console.log(`  ${f.puzzle_date}/${f.category} — ${f.reason || 'no reason recorded'}`)
  }
}
