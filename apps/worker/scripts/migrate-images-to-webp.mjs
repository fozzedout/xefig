#!/usr/bin/env node
// One-off migration: convert every existing JPEG puzzle image in R2
// to WebP, and update the D1 puzzle records to point at the new
// .webp filenames + content type. Idempotent — already-WebP entries
// are skipped, so it's safe to re-run.
//
// Usage:
//   1. Create .env.migrate next to this script (see .env.migrate.example).
//   2. From apps/worker/scripts: npm install && npm run migrate-webp
//
// Requires: R2 access keys (Cloudflare dashboard → R2 → Manage Access
// Keys → "Read & Write"), and wrangler logged in for the D1 updates.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

loadDotEnv(resolve(__dirname, '.env.migrate'))

const R2_ACCOUNT_ID = required('R2_ACCOUNT_ID')
const R2_ACCESS_KEY_ID = required('R2_ACCESS_KEY_ID')
const R2_SECRET_ACCESS_KEY = required('R2_SECRET_ACCESS_KEY')
const R2_BUCKET = process.env.R2_BUCKET || 'assets'
const D1_DATABASE_NAME = process.env.D1_DATABASE_NAME || 'daily_puzzles'
const WEBP_QUALITY = Number(process.env.WEBP_QUALITY || 78)
const DELETE_JPGS = process.env.DELETE_JPGS === 'true'
const DRY_RUN = process.env.DRY_RUN === 'true'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
})

// ---------------------------------------------------------------------------
// R2 helpers
// ---------------------------------------------------------------------------

async function listAllJpgKeys() {
  const keys = []
  let token
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: 'puzzles/',
        ContinuationToken: token,
      }),
    )
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.Key.endsWith('.jpg')) keys.push(obj.Key)
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function objectExists(key) {
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: key, MaxKeys: 1 }),
  )
  return (res.Contents ?? []).some((o) => o.Key === key)
}

async function downloadObject(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }))
  const chunks = []
  for await (const chunk of res.Body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function uploadObject(key, body, contentType) {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )
}

// ---------------------------------------------------------------------------
// Sharp conversion
// ---------------------------------------------------------------------------

async function jpegToWebp(jpegBuffer) {
  return await sharp(jpegBuffer).webp({ quality: WEBP_QUALITY }).toBuffer()
}

// ---------------------------------------------------------------------------
// D1 helpers (uses wrangler in your shell auth — no separate token needed)
// ---------------------------------------------------------------------------

function d1Query(sql) {
  // wrangler d1 execute outputs JSON when --json is passed.
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
  return JSON.parse(out)
}

function d1Exec(sql) {
  if (DRY_RUN) {
    console.log(`  [dry-run] SQL: ${sql.slice(0, 120)}${sql.length > 120 ? '…' : ''}`)
    return
  }
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, '--remote', '--command', sql],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
}

function fetchAllPuzzles() {
  const result = d1Query('SELECT date, categories FROM puzzles')
  // wrangler returns [{ results: [...], success: true, ... }]
  const rows = result?.[0]?.results ?? []
  return rows.map((r) => ({ date: r.date, categories: JSON.parse(r.categories) }))
}

function updatePuzzleCategories(date, categoriesJson) {
  // Single-quote escaping for SQLite string literals.
  const escaped = categoriesJson.replace(/'/g, "''")
  const sql = `UPDATE puzzles SET categories = '${escaped}', updated_at = datetime('now') WHERE date = '${date}'`
  d1Exec(sql)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Listing existing .jpg objects under puzzles/ in R2 bucket "${R2_BUCKET}"…`)
  const jpgKeys = await listAllJpgKeys()
  console.log(`Found ${jpgKeys.length} .jpg files.`)
  if (jpgKeys.length === 0) {
    console.log('Nothing to do.')
    return
  }

  // Convert R2 objects first; D1 updates happen after a successful pass
  // for each date so we don't end up with records pointing at .webp
  // files that haven't been written yet.
  let converted = 0
  let skipped = 0
  for (const jpgKey of jpgKeys) {
    const webpKey = jpgKey.replace(/\.jpg$/, '.webp')
    if (await objectExists(webpKey)) {
      skipped++
      continue
    }
    if (DRY_RUN) {
      console.log(`  [dry-run] would convert ${jpgKey} → ${webpKey}`)
      converted++
      continue
    }
    const jpegBuf = await downloadObject(jpgKey)
    const webpBuf = await jpegToWebp(jpegBuf)
    await uploadObject(webpKey, webpBuf, 'image/webp')
    converted++
    if (converted % 20 === 0) console.log(`  ${converted} converted…`)
  }
  console.log(`Converted ${converted} files (${skipped} already had a .webp counterpart).`)

  // Update D1 puzzle records to point at .webp paths.
  console.log('Updating D1 puzzle records…')
  const puzzles = fetchAllPuzzles()
  let updated = 0
  for (const { date, categories } of puzzles) {
    let dirty = false
    for (const cat of Object.keys(categories)) {
      const asset = categories[cat]
      if (!asset?.imageKey || !asset.imageKey.endsWith('.jpg')) continue
      const newKey = asset.imageKey.replace(/\.jpg$/, '.webp')
      const newThumb = asset.thumbnailKey?.replace(/\.jpg$/, '.webp')
      asset.imageKey = newKey
      asset.imageUrl = asset.imageUrl?.replace(/\.jpg(\?|$)/, '.webp$1')
      asset.contentType = 'image/webp'
      asset.fileName = asset.fileName?.replace(/\.jpg$/, '.webp') || `${cat}.webp`
      if (newThumb) {
        asset.thumbnailKey = newThumb
        asset.thumbnailUrl = asset.thumbnailUrl?.replace(/\.jpg(\?|$)/, '.webp$1')
      }
      dirty = true
    }
    if (!dirty) continue
    updatePuzzleCategories(date, JSON.stringify(categories))
    updated++
  }
  console.log(`Updated ${updated} puzzle records.`)

  if (DELETE_JPGS && !DRY_RUN) {
    console.log('Deleting old .jpg objects (DELETE_JPGS=true)…')
    let deleted = 0
    for (const jpgKey of jpgKeys) {
      // Defensive: only delete if a .webp counterpart exists.
      const webpKey = jpgKey.replace(/\.jpg$/, '.webp')
      if (!(await objectExists(webpKey))) continue
      await s3.send(
        new (await import('@aws-sdk/client-s3')).DeleteObjectCommand({
          Bucket: R2_BUCKET,
          Key: jpgKey,
        }),
      )
      deleted++
    }
    console.log(`Deleted ${deleted} .jpg objects.`)
  } else {
    console.log('Old .jpg files left in place. Set DELETE_JPGS=true to remove them once you confirm everything works.')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadDotEnv(path) {
  if (!existsSync(path)) return
  const raw = readFileSync(path, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

function required(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing required env var ${name}. Set it in apps/worker/scripts/.env.migrate or your shell.`)
    process.exit(1)
  }
  return v
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
