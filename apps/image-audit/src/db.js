import Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '..', 'audit.db')

let _db

export function getDb() {
  if (_db) return _db
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.exec(`
    CREATE TABLE IF NOT EXISTS audit_results (
      puzzle_date TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,        -- 'valid' | 'failed' | 'regenerated'
      reason TEXT,
      checked_at TEXT NOT NULL,
      image_url TEXT,
      PRIMARY KEY (puzzle_date, category)
    )
  `)
  return _db
}

export function getResult(date, category) {
  return getDb().prepare(
    'SELECT * FROM audit_results WHERE puzzle_date = ? AND category = ?'
  ).get(date, category)
}

export function upsertResult(date, category, status, reason, imageUrl) {
  getDb().prepare(`
    INSERT INTO audit_results (puzzle_date, category, status, reason, checked_at, image_url)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (puzzle_date, category) DO UPDATE SET
      status = excluded.status,
      reason = excluded.reason,
      checked_at = excluded.checked_at,
      image_url = excluded.image_url
  `).run(date, category, status, reason, new Date().toISOString(), imageUrl)
}

export function getSummary() {
  return getDb().prepare(`
    SELECT status, COUNT(*) as count FROM audit_results GROUP BY status
  `).all()
}

export function getFailures() {
  return getDb().prepare(`
    SELECT * FROM audit_results WHERE status = 'failed' ORDER BY puzzle_date, category
  `).all()
}

export function getPending(dates) {
  const db = getDb()
  const checked = db.prepare(
    'SELECT puzzle_date, category FROM audit_results'
  ).all()
  const checkedSet = new Set(checked.map(r => `${r.puzzle_date}:${r.category}`))
  return dates.flatMap(d =>
    ['jigsaw', 'slider', 'swap', 'polygram', 'diamond']
      .filter(c => !checkedSet.has(`${d}:${c}`))
      .map(c => ({ date: d, category: c }))
  )
}
