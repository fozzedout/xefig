// Pull a snapshot of puzzles + their assets from xefig.com into
// apps/desktop/offline-pack/. The embedded server in src/server.js
// reads from that directory at runtime, so once a pack is staged the
// desktop client can run with the network unplugged.
//
// Layout produced:
//   offline-pack/
//     api/
//       puzzles/
//         today.json          # alias of the most recent date pulled
//         2026-05-22.json     # raw API response per date
//     cdn/                    # /cdn/* assets mirrored verbatim
//       puzzles/
//         2026-05-22/
//           jigsaw.webp
//           jigsaw_thumb.webp
//           ...
//
// Usage:
//   node scripts/pull-puzzles.mjs                     # today only
//   node scripts/pull-puzzles.mjs 2026-05-20 2026-05-21 2026-05-22
//   API=https://xefig-beta.example.com node scripts/pull-puzzles.mjs   # different origin

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACK = join(here, '..', 'offline-pack')
const API = (process.env.API || 'https://xefig.com').replace(/\/+$/, '')

function mkdirpFor(filePath) {
  mkdirSync(dirname(filePath), { recursive: true })
}

function stripQuery(p) {
  return p.split('?')[0]
}

async function fetchJson(url) {
  console.log('GET', url)
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function fetchBinary(url) {
  console.log('GET', url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function stageAsset(assetUrl) {
  // assetUrl is e.g. "/cdn/puzzles/2026-05-22/jigsaw.webp?v=1730..."
  if (!assetUrl || !assetUrl.startsWith('/')) {
    console.warn('  skip non-relative asset', assetUrl)
    return
  }
  const clean = stripQuery(assetUrl)
  const dest = join(PACK, clean.replace(/^\/+/, ''))
  if (existsSync(dest)) {
    console.log('  cached', clean)
    return
  }
  const body = await fetchBinary(`${API}${clean}`)
  mkdirpFor(dest)
  writeFileSync(dest, body)
}

async function pullPuzzle(date) {
  console.log(`\n--- ${date} ---`)
  const puzzle = await fetchJson(`${API}/api/puzzles/${encodeURIComponent(date)}`)

  // Stage the JSON.
  const jsonPath = join(PACK, 'api', 'puzzles', `${date}.json`)
  mkdirpFor(jsonPath)
  writeFileSync(jsonPath, JSON.stringify(puzzle, null, 2))

  // Stage every category's image + thumbnail.
  for (const [cat, asset] of Object.entries(puzzle.categories || {})) {
    if (asset?.imageUrl) await stageAsset(asset.imageUrl)
    if (asset?.thumbnailUrl) await stageAsset(asset.thumbnailUrl)
  }

  return puzzle
}

const args = process.argv.slice(2)
const explicitDates = args.length
  ? args
  : [new Date().toISOString().slice(0, 10)]

let mostRecent = null
for (const date of explicitDates) {
  try {
    const p = await pullPuzzle(date)
    if (!mostRecent || (p.date && p.date > mostRecent.date)) mostRecent = p
  } catch (err) {
    console.error(`Failed to pull ${date}:`, err.message)
  }
}

// /api/puzzles/today is what the bundle hits first; alias it to the
// newest date in the pack so the launcher has something to show.
if (mostRecent) {
  const todayPath = join(PACK, 'api', 'puzzles', 'today.json')
  mkdirpFor(todayPath)
  writeFileSync(todayPath, JSON.stringify(mostRecent, null, 2))
  console.log(`\nAliased today.json -> ${mostRecent.date}`)
}

console.log('\nOffline pack written to:', PACK)
