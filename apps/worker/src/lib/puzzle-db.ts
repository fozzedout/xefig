import type { PuzzleCategory, PuzzleRecord, PromptHistoryItem } from '../types'

let tablesReady = false

const PROMPT_HISTORY_LIMIT = 260

type PendingBatchJob = {
  batchName: string
  targetDate: string
  categories: Record<PuzzleCategory, { theme: string; keywords: string[] }>
  submittedAt: string
  phase: 'submitted' | 'fetched'
  processedCategories: PuzzleCategory[]
  requestedCategories?: PuzzleCategory[]
}

export type { PendingBatchJob }

// ---------------------------------------------------------------------------
// Table initialisation (follows ensureSyncTables pattern)
// ---------------------------------------------------------------------------

export async function ensurePuzzleTables(db: D1Database): Promise<void> {
  if (tablesReady) return

  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS puzzles (date TEXT PRIMARY KEY, difficulty TEXT NOT NULL DEFAULT 'adaptive', categories TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS prompt_history (id INTEGER PRIMARY KEY AUTOINCREMENT, descriptors TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS batch_jobs (id INTEGER PRIMARY KEY CHECK (id = 1), batch_name TEXT NOT NULL, target_date TEXT NOT NULL, categories TEXT NOT NULL DEFAULT '{}', submitted_at TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'submitted', processed_categories TEXT NOT NULL DEFAULT '[]', requested_categories TEXT)`,
    ),
  ])

  tablesReady = true
}

// ---------------------------------------------------------------------------
// Puzzles
// ---------------------------------------------------------------------------

export async function getPuzzleByDateD1(db: D1Database, date: string): Promise<PuzzleRecord | null> {
  const row = await db
    .prepare('SELECT date, difficulty, categories, created_at, updated_at FROM puzzles WHERE date = ?')
    .bind(date)
    .first<{ date: string; difficulty: string; categories: string; created_at: string; updated_at: string }>()

  if (!row) return null

  try {
    return {
      date: row.date,
      difficulty: row.difficulty,
      categories: JSON.parse(row.categories),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  } catch {
    return null
  }
}

export async function savePuzzleRecord(db: D1Database, record: PuzzleRecord): Promise<void> {
  await db
    .prepare(
      'INSERT OR REPLACE INTO puzzles (date, difficulty, categories, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      record.date,
      record.difficulty,
      JSON.stringify(record.categories),
      record.createdAt,
      record.updatedAt,
    )
    .run()
}

export async function findNextUnscheduledDateD1(
  db: D1Database,
  fromDate: string,
  maxDaysToScan: number,
): Promise<string | null> {
  // Generate all candidate dates
  const candidates: string[] = []
  let current = fromDate
  for (let i = 0; i < maxDaysToScan; i++) {
    candidates.push(current)
    const base = Date.parse(`${current}T00:00:00.000Z`)
    current = new Date(base + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  }

  if (candidates.length === 0) return null

  // Fetch all existing dates in range with a single query
  const placeholders = candidates.map(() => '?').join(',')
  const rows = await db
    .prepare(`SELECT date FROM puzzles WHERE date IN (${placeholders})`)
    .bind(...candidates)
    .all<{ date: string }>()

  const existing = new Set((rows.results || []).map((r) => r.date))

  for (const candidate of candidates) {
    if (!existing.has(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Prompt history
// ---------------------------------------------------------------------------

export async function getPromptHistoryD1(db: D1Database): Promise<PromptHistoryItem[]> {
  const rows = await db
    .prepare('SELECT descriptors, created_at FROM prompt_history ORDER BY id DESC LIMIT ?')
    .bind(PROMPT_HISTORY_LIMIT)
    .all<{ descriptors: string; created_at: string }>()

  const items: PromptHistoryItem[] = []
  for (const row of (rows.results || []).reverse()) {
    try {
      const descriptors = JSON.parse(row.descriptors) as unknown
      if (Array.isArray(descriptors)) {
        items.push({
          descriptors: descriptors.filter((d): d is string => typeof d === 'string'),
          createdAt: row.created_at,
        })
      }
    } catch {
      // skip malformed rows
    }
  }
  return items
}

export async function appendPromptHistory(db: D1Database, item: PromptHistoryItem): Promise<void> {
  await db
    .prepare('INSERT INTO prompt_history (descriptors, created_at) VALUES (?, ?)')
    .bind(JSON.stringify(item.descriptors), item.createdAt)
    .run()

  // Trim old entries
  await db
    .prepare(
      'DELETE FROM prompt_history WHERE id NOT IN (SELECT id FROM prompt_history ORDER BY id DESC LIMIT ?)',
    )
    .bind(PROMPT_HISTORY_LIMIT)
    .run()
}

// ---------------------------------------------------------------------------
// Batch jobs
// ---------------------------------------------------------------------------

export async function getBatchJob(db: D1Database): Promise<PendingBatchJob | null> {
  const row = await db
    .prepare(
      'SELECT batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories FROM batch_jobs WHERE id = 1',
    )
    .first<{
      batch_name: string
      target_date: string
      categories: string
      submitted_at: string
      phase: string
      processed_categories: string
      requested_categories: string | null
    }>()

  if (!row) return null

  try {
    return {
      batchName: row.batch_name,
      targetDate: row.target_date,
      categories: JSON.parse(row.categories),
      submittedAt: row.submitted_at,
      phase: (row.phase as 'submitted' | 'fetched') || 'submitted',
      processedCategories: JSON.parse(row.processed_categories) || [],
      requestedCategories: row.requested_categories ? JSON.parse(row.requested_categories) : undefined,
    }
  } catch {
    return null
  }
}

export async function saveBatchJob(db: D1Database, job: PendingBatchJob): Promise<void> {
  await db
    .prepare(
      'INSERT OR REPLACE INTO batch_jobs (id, batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      job.batchName,
      job.targetDate,
      JSON.stringify(job.categories),
      job.submittedAt,
      job.phase,
      JSON.stringify(job.processedCategories),
      job.requestedCategories ? JSON.stringify(job.requestedCategories) : null,
    )
    .run()
}

export async function deleteBatchJob(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM batch_jobs WHERE id = 1').run()
}
