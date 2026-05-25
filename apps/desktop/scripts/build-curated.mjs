// Build curated puzzle.json manifests from hand-made artwork.
//
// Each curated area is a folder under apps/desktop/curated/<id>/, where
// <id> is a reserved ISO date BEFORE the daily archive start (2026-03-17)
// so it never collides with real daily content and still parses as a
// date for the in-game label. Drop one image per mode into the folder,
// named after the puzzle CATEGORY key:
//
//   curated/2026-01-01/
//     jigsaw.webp  slider.webp  swap.webp  polygram.webp  diamond.webp
//     meta.json            # optional: { "title", "theme", "tags": [...] }
//     <mode>_thumb.webp    # optional: falls back to the full image
//
// This (re)writes puzzle.json in each folder, shaped exactly like a
// /api/puzzles/<date> response, so the web bundle and the embedded
// server (src/server.js) serve it with no special-casing. The folder id
// is used verbatim as the payload `date` (the run-save key) and the
// asset path — point a demo-config.json area's puzzleDate at it to play
// the curated area instead of a daily puzzle.
//
// Usage:
//   node scripts/build-curated.mjs              # every area folder
//   node scripts/build-curated.mjs 2026-01-01   # one area

import { readdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CURATED = join(here, '..', 'curated')

// Puzzle category keys, in slice order. Mirrors GAME_MODE_TO_PUZZLE_CATEGORY
// in apps/web/src/main.js — these are the filenames artwork must use.
const MODES = ['jigsaw', 'slider', 'swap', 'polygram', 'diamond']
const IMG_EXTS = ['.webp', '.jpg', '.jpeg', '.png']
const CONTENT_TYPE = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }
const ARCHIVE_START = '2026-03-17' // daily archive begins here; curated ids must precede it

// First existing `<base><ext>` for our known extensions, or null.
function findImage(dir, base) {
  for (const ext of IMG_EXTS) {
    if (existsSync(join(dir, base + ext))) return base + ext
  }
  return null
}

function buildArea(id) {
  const dir = join(CURATED, id)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`  ✗ ${id}: not a folder under curated/`)
    return false
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(id) && id >= ARCHIVE_START) {
    console.warn(`  ! ${id}: id is on/after the daily archive start (${ARCHIVE_START}) — may collide with real daily content`)
  }

  let meta = {}
  const metaPath = join(dir, 'meta.json')
  if (existsSync(metaPath)) {
    try { meta = JSON.parse(readFileSync(metaPath, 'utf8')) || {} }
    catch (err) { console.warn(`  ! ${id}: meta.json unparseable (${err.message}); ignoring`) }
  }
  const theme = meta.theme || meta.title || id
  const tags = Array.isArray(meta.tags) ? meta.tags : []

  const categories = {}
  for (const mode of MODES) {
    const file = findImage(dir, mode)
    if (!file) {
      console.warn(`  ! ${id}: no image for "${mode}" (expected ${mode}.webp) — slice will be absent`)
      continue
    }
    const ext = file.slice(file.lastIndexOf('.'))
    const thumbFile = findImage(dir, `${mode}_thumb`) || file
    categories[mode] = {
      imageKey: `curated/${id}/${file}`,
      imageUrl: `/cdn/curated/${id}/${file}`,
      contentType: CONTENT_TYPE[ext] || 'application/octet-stream',
      fileName: file,
      theme,
      tags,
      thumbnailKey: `curated/${id}/${thumbFile}`,
      thumbnailUrl: `/cdn/curated/${id}/${thumbFile}`,
    }
  }

  if (Object.keys(categories).length === 0) {
    console.error(`  ✗ ${id}: no mode images found — nothing to build`)
    return false
  }

  const now = new Date().toISOString()
  const puzzle = {
    date: id,
    difficulty: 'adaptive',
    curated: true,
    title: meta.title || null,
    categories,
    createdAt: now,
    updatedAt: now,
  }
  writeFileSync(join(dir, 'puzzle.json'), JSON.stringify(puzzle, null, 2))
  console.log(`  ✓ ${id}: ${Object.keys(categories).join(', ')}`)
  return true
}

const args = process.argv.slice(2)
let ids = args
if (!ids.length) {
  if (!existsSync(CURATED)) {
    console.error(`No curated/ directory at ${CURATED}`)
    process.exit(1)
  }
  ids = readdirSync(CURATED).filter((name) => {
    const full = join(CURATED, name)
    return statSync(full).isDirectory()
  })
}

if (!ids.length) {
  console.log('No curated areas to build. Create curated/<id>/ with mode images first.')
  process.exit(0)
}

console.log(`Building ${ids.length} curated area(s):`)
let ok = 0
for (const id of ids) if (buildArea(id)) ok++
console.log(`\n${ok}/${ids.length} built.`)
process.exit(ok === ids.length ? 0 : 1)
