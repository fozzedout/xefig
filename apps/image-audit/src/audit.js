#!/usr/bin/env node

import { login, fetchPuzzle, fetchOverview, fetchImage, submitRegeneration } from './api.js'
import { getResult, upsertResult, getSummary, getPending } from './db.js'
import { evaluateImage } from './vision.js'
import { CATEGORIES } from './config.js'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const positional = args.filter(a => !a.startsWith('--'))

const autoRegen = flags.has('--regen')
const skipChecked = !flags.has('--recheck')
const dryRun = flags.has('--dry-run')

function usage() {
  console.log(`
Usage: node src/audit.js [options] [date|date-range]

Examples:
  node src/audit.js                     # audit all scheduled puzzles
  node src/audit.js 2026-04-20          # audit one date
  node src/audit.js 2026-04-01 2026-04-30  # audit a range
  node src/audit.js --regen             # auto-submit regen for failures
  node src/audit.js --recheck           # re-evaluate already-checked images
  node src/audit.js --dry-run           # evaluate but don't record or regen

Options:
  --regen     Automatically submit regeneration for failed images
  --recheck   Re-evaluate images that were previously marked valid
  --dry-run   Show what would happen without recording results
`)
  process.exit(0)
}

if (flags.has('--help') || flags.has('-h')) usage()

async function promptPassword() {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise(resolve => {
    rl.question('Admin password: ', answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function dateRange(from, to) {
  const dates = []
  const d = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return dates
}

async function resolveDates() {
  if (positional.length === 1) return [positional[0]]
  if (positional.length === 2) return dateRange(positional[0], positional[1])

  const today = new Date().toISOString().slice(0, 10)
  const sixtyAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10)
  const overview = await fetchOverview(sixtyAgo, 120)
  return Object.keys(overview.scheduled).sort()
}

const needsAuth = autoRegen || positional.length === 0

async function run() {
  if (needsAuth) {
    const password = process.env.XEFIG_ADMIN_PASSWORD || await promptPassword()
    console.log('Logging in...')
    await login(password)
    console.log('Authenticated.\n')
  }

  const dates = await resolveDates()
  console.log(`Auditing ${dates.length} date(s): ${dates[0]} → ${dates[dates.length - 1]}\n`)

  let checked = 0, passed = 0, failed = 0, skipped = 0, regenSubmitted = 0

  for (const date of dates) {
    const puzzle = await fetchPuzzle(date)
    if (!puzzle) {
      console.log(`${date}  — no puzzle found, skipping`)
      continue
    }

    for (const category of CATEGORIES) {
      const asset = puzzle.categories?.[category]
      if (!asset?.imageUrl) {
        console.log(`${date}/${category}  — no image, skipping`)
        continue
      }

      const existing = getResult(date, category)
      if (skipChecked && existing) {
        skipped++
        continue
      }

      process.stdout.write(`${date}/${category}  evaluating... `)

      try {
        const imageBuffer = await fetchImage(asset.imageUrl)
        const result = await evaluateImage(imageBuffer)
        checked++

        if (result.pass) {
          passed++
          console.log('✓ valid')
          if (!dryRun) upsertResult(date, category, 'valid', null, asset.imageUrl)
        } else {
          failed++
          console.log(`✗ FAILED — ${result.reason}`)
          if (!dryRun) upsertResult(date, category, 'failed', result.reason, asset.imageUrl)

          if (autoRegen && !dryRun) {
            try {
              const prompt = `A high quality image suitable for a ${category} puzzle. Theme: ${asset.theme}. Tags: ${asset.tags?.join(', ') || 'none'}.`
              const regenResult = await submitRegeneration(category, prompt, date)
              regenSubmitted++
              upsertResult(date, category, 'regenerated', result.reason, asset.imageUrl)
              console.log(`  ↻ regeneration submitted: ${regenResult.batchName || 'ok'}`)
            } catch (err) {
              console.error(`  ↻ regeneration failed: ${err.message}`)
            }
          }
        }
      } catch (err) {
        console.log(`ERROR — ${err.message}`)
      }
    }
  }

  console.log(`
──────────────────────────
  Checked:      ${checked}
  Passed:       ${passed}
  Failed:       ${failed}
  Skipped:      ${skipped} (already checked)
  Regen sent:   ${regenSubmitted}
──────────────────────────`)

  if (!dryRun) {
    const summary = getSummary()
    console.log('\nAll-time totals:')
    for (const row of summary) {
      console.log(`  ${row.status}: ${row.count}`)
    }
  }
}

run().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
