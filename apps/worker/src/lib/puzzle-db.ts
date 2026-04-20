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
  // Track validation failures per category for retry logic
  validationFailures?: Record<string, number>
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
    // Queue schema: AUTOINCREMENT id + UNIQUE batch_name (each Gemini
    // batch is unique). target_date is non-unique so multiple jobs can
    // target the same date — needed for stacking single-category
    // resubmits (e.g. retry jigsaw for 2026-04-20 while also re-submitting
    // diamond for the same date).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS batch_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_name TEXT NOT NULL UNIQUE, target_date TEXT NOT NULL, categories TEXT NOT NULL DEFAULT '{}', submitted_at TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'submitted', processed_categories TEXT NOT NULL DEFAULT '[]', requested_categories TEXT, validation_failures TEXT)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ),
  ])

  // Migration path — covers two older schemas:
  //  1. CHECK (id = 1) singleton — rebuild to current schema.
  //  2. UNIQUE target_date (short-lived queue attempt) — rebuild to
  //     drop the constraint since it blocks single-category stacking.
  try {
    const row = await db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='batch_jobs'`)
      .first<{ sql: string }>()
    const needsRebuild =
      row?.sql &&
      (row.sql.includes('CHECK (id = 1)') ||
        /target_date\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql) ||
        !/batch_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql))
    if (needsRebuild) {
      await db.batch([
        db.prepare(`ALTER TABLE batch_jobs RENAME TO batch_jobs_legacy`),
        db.prepare(
          `CREATE TABLE batch_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_name TEXT NOT NULL UNIQUE, target_date TEXT NOT NULL, categories TEXT NOT NULL DEFAULT '{}', submitted_at TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'submitted', processed_categories TEXT NOT NULL DEFAULT '[]', requested_categories TEXT, validation_failures TEXT)`,
        ),
        db.prepare(
          `INSERT INTO batch_jobs (id, batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures) SELECT id, batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures FROM batch_jobs_legacy`,
        ),
        db.prepare(`DROP TABLE batch_jobs_legacy`),
      ])
    }
  } catch {
    // Migration best-effort; if it fails we'll retry on next cold start.
  }

  // Add validation_failures column if missing (pre-migration fallback).
  try {
    await db.prepare(`ALTER TABLE batch_jobs ADD COLUMN validation_failures TEXT`).run()
  } catch {
    // Column already exists — ignore
  }

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

export async function getScheduledDatesInRange(
  db: D1Database,
  from: string,
  to: string,
): Promise<Record<string, string[]>> {
  const rows = await db
    .prepare('SELECT date, categories FROM puzzles WHERE date >= ? AND date <= ? ORDER BY date ASC')
    .bind(from, to)
    .all<{ date: string; categories: string }>()

  const result: Record<string, string[]> = {}
  for (const row of rows.results || []) {
    try {
      const cats = JSON.parse(row.categories) as Record<string, unknown>
      result[row.date] = Object.keys(cats).filter((k) => {
        const asset = cats[k] as Record<string, unknown> | undefined
        return asset && typeof asset.imageUrl === 'string'
      })
    } catch {
      result[row.date] = []
    }
  }
  return result
}

export async function findNextUnscheduledDateD1(
  db: D1Database,
  fromDate: string,
  maxDaysToScan: number,
  extraUnavailableDates?: ReadonlySet<string>,
): Promise<string | null> {
  // Fetch all scheduled dates from fromDate onwards (ordered)
  const rows = await db
    .prepare('SELECT date FROM puzzles WHERE date >= ? ORDER BY date ASC')
    .bind(fromDate)
    .all<{ date: string }>()

  const dateSet = new Set((rows.results || []).map((r) => r.date))

  // Walk from fromDate looking for first missing day that isn't already
  // queued for batch generation either.
  let current = fromDate
  for (let i = 0; i < maxDaysToScan; i++) {
    if (!dateSet.has(current) && !extraUnavailableDates?.has(current)) {
      return current
    }
    const base = Date.parse(`${current}T00:00:00.000Z`)
    current = new Date(base + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
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
// Batch jobs (queue)
// ---------------------------------------------------------------------------

type BatchJobRow = {
  batch_name: string
  target_date: string
  categories: string
  submitted_at: string
  phase: string
  processed_categories: string
  requested_categories: string | null
  validation_failures: string | null
}

function rowToJob(row: BatchJobRow | null): PendingBatchJob | null {
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
      validationFailures: row.validation_failures ? JSON.parse(row.validation_failures) : undefined,
    }
  } catch {
    return null
  }
}

// Oldest job in the queue (FIFO by id). Back-compat name: callers that
// previously expected the singleton still work — they now get the head
// of the queue.
export async function getBatchJob(db: D1Database): Promise<PendingBatchJob | null> {
  const row = await db
    .prepare(
      'SELECT batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures FROM batch_jobs ORDER BY id ASC LIMIT 1',
    )
    .first<BatchJobRow>()
  return rowToJob(row ?? null)
}

export async function getBatchJobByTargetDate(
  db: D1Database,
  targetDate: string,
): Promise<PendingBatchJob | null> {
  // Multiple jobs may share a target_date (e.g. two single-category
  // resubmits for the same day). Return the oldest so callers that
  // want "is there anything for this date" still work.
  const row = await db
    .prepare(
      'SELECT batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures FROM batch_jobs WHERE target_date = ? ORDER BY id ASC LIMIT 1',
    )
    .bind(targetDate)
    .first<BatchJobRow>()
  return rowToJob(row ?? null)
}

export async function getBatchJobsByTargetDate(
  db: D1Database,
  targetDate: string,
): Promise<PendingBatchJob[]> {
  const rows = await db
    .prepare(
      'SELECT batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures FROM batch_jobs WHERE target_date = ? ORDER BY id ASC',
    )
    .bind(targetDate)
    .all<BatchJobRow>()
  const out: PendingBatchJob[] = []
  for (const r of rows.results || []) {
    const job = rowToJob(r)
    if (job) out.push(job)
  }
  return out
}

export async function getBatchJobByBatchName(
  db: D1Database,
  batchName: string,
): Promise<PendingBatchJob | null> {
  const row = await db
    .prepare(
      'SELECT batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures FROM batch_jobs WHERE batch_name = ?',
    )
    .bind(batchName)
    .first<BatchJobRow>()
  return rowToJob(row ?? null)
}

export async function getAllPendingBatchJobs(db: D1Database): Promise<PendingBatchJob[]> {
  const rows = await db
    .prepare(
      'SELECT batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures FROM batch_jobs ORDER BY id ASC',
    )
    .all<BatchJobRow>()
  const results: PendingBatchJob[] = []
  for (const r of rows.results || []) {
    const job = rowToJob(r)
    if (job) results.push(job)
  }
  return results
}

export async function saveBatchJob(db: D1Database, job: PendingBatchJob): Promise<void> {
  // batch_name has a UNIQUE index (each Gemini batch id is unique), so
  // INSERT OR REPLACE updates the row in place when the same batch is
  // saved again and inserts otherwise. target_date is non-unique so
  // multiple jobs can target the same date.
  await db
    .prepare(
      'INSERT OR REPLACE INTO batch_jobs (batch_name, target_date, categories, submitted_at, phase, processed_categories, requested_categories, validation_failures) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      job.batchName,
      job.targetDate,
      JSON.stringify(job.categories),
      job.submittedAt,
      job.phase,
      JSON.stringify(job.processedCategories),
      job.requestedCategories ? JSON.stringify(job.requestedCategories) : null,
      job.validationFailures ? JSON.stringify(job.validationFailures) : null,
    )
    .run()
}

export async function deleteBatchJob(db: D1Database, batchName: string): Promise<void> {
  await db.prepare('DELETE FROM batch_jobs WHERE batch_name = ?').bind(batchName).run()
}

export async function getAppSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function setAppSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(key, value)
    .run()
}
