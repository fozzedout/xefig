const SHARE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const SHARE_CODE_LENGTH = 6

let tablesReady = false

export async function ensureSyncTables(db: D1Database): Promise<void> {
  if (tablesReady) return

  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_profiles (player_guid TEXT PRIMARY KEY, share_code TEXT NOT NULL UNIQUE, profile_name TEXT NOT NULL DEFAULT '', board_color_index INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_completed (player_guid TEXT NOT NULL, puzzle_date TEXT NOT NULL, game_mode TEXT NOT NULL, difficulty TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0, best_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (player_guid, puzzle_date, game_mode))`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_active_runs (player_guid TEXT NOT NULL, puzzle_date TEXT NOT NULL, game_mode TEXT NOT NULL, run_state TEXT NOT NULL DEFAULT '{}', elapsed_ms INTEGER NOT NULL DEFAULT 0, difficulty TEXT, image_url TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (player_guid, puzzle_date, game_mode))`,
    ),
  ])

  // Migrate old schema: add new columns if missing, migrate JSON blob data
  try {
    const cols = await db
      .prepare(`SELECT name FROM pragma_table_info('player_profiles')`)
      .all<{ name: string }>()
    const colNames = new Set((cols.results || []).map((r) => r.name))

    // Add new columns if they don't exist
    if (!colNames.has('profile_name')) {
      try { await db.prepare(`ALTER TABLE player_profiles ADD COLUMN profile_name TEXT NOT NULL DEFAULT ''`).run() } catch {}
    }
    if (!colNames.has('board_color_index')) {
      try { await db.prepare(`ALTER TABLE player_profiles ADD COLUMN board_color_index INTEGER NOT NULL DEFAULT 0`).run() } catch {}
    }

    // Migrate JSON blob if old column exists
    if (colNames.has('profile_data')) {
      await migrateFromJsonBlob(db)
    }
  } catch {
    // Old table may not exist at all — that's fine
  }

  tablesReady = true
}

async function migrateFromJsonBlob(db: D1Database): Promise<void> {
  const rows = await db
    .prepare(`SELECT player_guid, profile_data FROM player_profiles WHERE profile_data IS NOT NULL AND profile_data != '{}'`)
    .all<{ player_guid: string; profile_data: string }>()

  for (const row of rows.results || []) {
    try {
      const data = JSON.parse(row.profile_data) as {
        completedRuns?: Record<string, Record<string, { difficulty?: string; elapsedActiveMs?: number; bestElapsedMs?: number; completedAt?: string }>>
        activeRuns?: Record<string, { puzzleDate?: string; gameMode?: string; difficulty?: string; imageUrl?: string; elapsedActiveMs?: number; puzzleState?: unknown; updatedAt?: string }>
        boardColorIndex?: number
        profileName?: string
      }

      const stmts: D1PreparedStatement[] = []

      // Migrate settings
      if (data.profileName || data.boardColorIndex) {
        stmts.push(
          db
            .prepare(`UPDATE player_profiles SET profile_name = ?, board_color_index = ? WHERE player_guid = ?`)
            .bind(data.profileName || '', data.boardColorIndex || 0, row.player_guid),
        )
      }

      // Migrate completed runs
      if (data.completedRuns) {
        for (const [date, modes] of Object.entries(data.completedRuns)) {
          for (const [mode, entry] of Object.entries(modes || {})) {
            if (!entry) continue
            stmts.push(
              db
                .prepare(
                  `INSERT OR IGNORE INTO player_completed (player_guid, puzzle_date, game_mode, difficulty, elapsed_ms, best_ms, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .bind(
                  row.player_guid,
                  date,
                  mode,
                  entry.difficulty || null,
                  entry.elapsedActiveMs || 0,
                  entry.bestElapsedMs || entry.elapsedActiveMs || 0,
                  entry.completedAt || '',
                ),
            )
          }
        }
      }

      // Migrate active runs
      if (data.activeRuns) {
        for (const [key, run] of Object.entries(data.activeRuns || {})) {
          if (!run) continue
          const parts = key.replace('xefig:run:', '').split(':')
          stmts.push(
            db
              .prepare(
                `INSERT OR IGNORE INTO player_active_runs (player_guid, puzzle_date, game_mode, run_state, elapsed_ms, difficulty, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                row.player_guid,
                parts[0] || run.puzzleDate || '',
                parts[1] || run.gameMode || '',
                JSON.stringify(run.puzzleState || {}),
                run.elapsedActiveMs || 0,
                run.difficulty || null,
                run.imageUrl || null,
                run.updatedAt || '',
              ),
          )
        }
      }

      // Batch in chunks of 50
      for (let i = 0; i < stmts.length; i += 50) {
        await db.batch(stmts.slice(i, i + 50))
      }
    } catch {
      // Skip broken rows
    }
  }

  // Drop the old column
  try {
    await db.prepare(`ALTER TABLE player_profiles DROP COLUMN profile_data`).run()
  } catch {
    // Column may already be dropped
  }
}

function generateShareCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SHARE_CODE_LENGTH))
  return Array.from(bytes, (b) => SHARE_CHARS[b % SHARE_CHARS.length]).join('')
}

function isValidPlayerGuid(guid: unknown): guid is string {
  return typeof guid === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(guid)
}

function isValidShareCode(code: unknown): code is string {
  return (
    typeof code === 'string' &&
    code.length === SHARE_CODE_LENGTH &&
    /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(code)
  )
}

// ─── Assemble profile from normalized tables ───

type AssembledProfile = {
  settings: { profileName: string; boardColorIndex: number }
  completedRuns: Record<string, Record<string, { difficulty: string | null; elapsedActiveMs: number; bestElapsedMs: number; completedAt: string }>>
  activeRuns: Record<string, { puzzleDate: string; gameMode: string; difficulty: string | null; imageUrl: string | null; elapsedActiveMs: number; puzzleState: unknown; updatedAt: string }>
  updatedAt: string
}

async function assembleProfile(db: D1Database, playerGuid: string): Promise<AssembledProfile | null> {
  const [profileResult, completedResult, activeResult] = await db.batch([
    db.prepare('SELECT profile_name, board_color_index, updated_at FROM player_profiles WHERE player_guid = ?').bind(playerGuid),
    db.prepare('SELECT puzzle_date, game_mode, difficulty, elapsed_ms, best_ms, completed_at FROM player_completed WHERE player_guid = ?').bind(playerGuid),
    db.prepare('SELECT puzzle_date, game_mode, run_state, elapsed_ms, difficulty, image_url, updated_at FROM player_active_runs WHERE player_guid = ?').bind(playerGuid),
  ])

  const profile = profileResult.results?.[0] as { profile_name: string; board_color_index: number; updated_at: string } | undefined
  if (!profile) return null

  const completedRuns: AssembledProfile['completedRuns'] = {}
  for (const row of (completedResult.results || []) as { puzzle_date: string; game_mode: string; difficulty: string | null; elapsed_ms: number; best_ms: number; completed_at: string }[]) {
    if (!completedRuns[row.puzzle_date]) completedRuns[row.puzzle_date] = {}
    completedRuns[row.puzzle_date][row.game_mode] = {
      difficulty: row.difficulty,
      elapsedActiveMs: row.elapsed_ms,
      bestElapsedMs: row.best_ms,
      completedAt: row.completed_at,
    }
  }

  const activeRuns: AssembledProfile['activeRuns'] = {}
  for (const row of (activeResult.results || []) as { puzzle_date: string; game_mode: string; run_state: string; elapsed_ms: number; difficulty: string | null; image_url: string | null; updated_at: string }[]) {
    const key = `xefig:run:${row.puzzle_date}:${row.game_mode}`
    activeRuns[key] = {
      puzzleDate: row.puzzle_date,
      gameMode: row.game_mode,
      difficulty: row.difficulty,
      imageUrl: row.image_url,
      elapsedActiveMs: row.elapsed_ms,
      puzzleState: JSON.parse(row.run_state || '{}'),
      updatedAt: row.updated_at,
    }
  }

  return {
    settings: { profileName: profile.profile_name, boardColorIndex: profile.board_color_index },
    completedRuns,
    activeRuns,
    updatedAt: profile.updated_at,
  }
}

// ─── Public API ───

export async function registerProfile(
  db: D1Database,
  playerGuid: string,
): Promise<{ shareCode: string; settings: object; completedRuns: object; activeRuns: object; updatedAt: string }> {
  await ensureSyncTables(db)

  if (!isValidPlayerGuid(playerGuid)) {
    throw new Error('Invalid playerGuid.')
  }

  const existing = await db
    .prepare('SELECT share_code FROM player_profiles WHERE player_guid = ?')
    .bind(playerGuid)
    .first<{ share_code: string }>()

  if (existing) {
    const assembled = await assembleProfile(db, playerGuid)
    return {
      shareCode: existing.share_code,
      settings: assembled?.settings || { profileName: '', boardColorIndex: 0 },
      completedRuns: assembled?.completedRuns || {},
      activeRuns: assembled?.activeRuns || {},
      updatedAt: assembled?.updatedAt || '',
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShareCode()
    try {
      const result = await db
        .prepare(
          `INSERT INTO player_profiles (player_guid, share_code, updated_at, created_at) VALUES (?, ?, datetime('now'), datetime('now')) RETURNING updated_at`,
        )
        .bind(playerGuid, code)
        .first<{ updated_at: string }>()

      return {
        shareCode: code,
        settings: { profileName: '', boardColorIndex: 0 },
        completedRuns: {},
        activeRuns: {},
        updatedAt: result?.updated_at ?? '',
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('UNIQUE') && attempt < 4) continue
      throw e
    }
  }

  throw new Error('Failed to generate unique share code.')
}

export async function linkProfile(
  db: D1Database,
  shareCode: string,
): Promise<{ playerGuid: string; settings: object; completedRuns: object; activeRuns: object; updatedAt: string } | null> {
  await ensureSyncTables(db)

  if (!isValidShareCode(shareCode)) return null

  const row = await db
    .prepare('SELECT player_guid FROM player_profiles WHERE share_code = ?')
    .bind(shareCode)
    .first<{ player_guid: string }>()

  if (!row) return null

  const assembled = await assembleProfile(db, row.player_guid)
  if (!assembled) return null

  return {
    playerGuid: row.player_guid,
    settings: assembled.settings,
    completedRuns: assembled.completedRuns,
    activeRuns: assembled.activeRuns,
    updatedAt: assembled.updatedAt,
  }
}

export type PushInput = {
  playerGuid: string
  updatedAt: string | null
  force: boolean
  settings?: { profileName?: string; boardColorIndex?: number }
  completedRun?: { puzzleDate: string; gameMode: string; difficulty?: string; elapsedActiveMs: number; bestElapsedMs: number; completedAt: string }
  activeRun?: { puzzleDate: string; gameMode: string; difficulty?: string; imageUrl?: string; elapsedActiveMs: number; puzzleState: unknown; updatedAt: string }
  fullProfile?: {
    settings: { profileName: string; boardColorIndex: number }
    completedRuns: Record<string, Record<string, { difficulty?: string; elapsedActiveMs?: number; bestElapsedMs?: number; completedAt?: string }>>
    activeRuns: Record<string, { puzzleDate?: string; gameMode?: string; difficulty?: string; imageUrl?: string; elapsedActiveMs?: number; puzzleState?: unknown; updatedAt?: string }>
  }
}

export async function pushProfile(
  db: D1Database,
  input: PushInput,
): Promise<
  | { ok: true; updatedAt: string }
  | { conflict: true; serverData: AssembledProfile; serverUpdatedAt: string }
  | { notFound: true }
> {
  await ensureSyncTables(db)

  if (!isValidPlayerGuid(input.playerGuid)) {
    throw new Error('Invalid playerGuid.')
  }

  const existing = await db
    .prepare('SELECT updated_at FROM player_profiles WHERE player_guid = ?')
    .bind(input.playerGuid)
    .first<{ updated_at: string }>()

  if (!existing) return { notFound: true }

  // Conflict detection
  if (!input.force && input.updatedAt && existing.updated_at !== input.updatedAt) {
    const assembled = await assembleProfile(db, input.playerGuid)
    return {
      conflict: true,
      serverData: assembled!,
      serverUpdatedAt: existing.updated_at,
    }
  }

  const stmts: D1PreparedStatement[] = []

  // Full profile replacement (initial sync, conflict resolution)
  if (input.fullProfile) {
    const fp = input.fullProfile

    stmts.push(
      db
        .prepare('UPDATE player_profiles SET profile_name = ?, board_color_index = ?, updated_at = datetime(\'now\') WHERE player_guid = ?')
        .bind(fp.settings.profileName || '', fp.settings.boardColorIndex || 0, input.playerGuid),
    )

    // Clear and reinsert completed
    stmts.push(db.prepare('DELETE FROM player_completed WHERE player_guid = ?').bind(input.playerGuid))
    if (fp.completedRuns) {
      for (const [date, modes] of Object.entries(fp.completedRuns)) {
        for (const [mode, entry] of Object.entries(modes || {})) {
          if (!entry) continue
          stmts.push(
            db
              .prepare('INSERT INTO player_completed (player_guid, puzzle_date, game_mode, difficulty, elapsed_ms, best_ms, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .bind(input.playerGuid, date, mode, entry.difficulty || null, entry.elapsedActiveMs || 0, entry.bestElapsedMs || entry.elapsedActiveMs || 0, entry.completedAt || ''),
          )
        }
      }
    }

    // Clear and reinsert active runs
    stmts.push(db.prepare('DELETE FROM player_active_runs WHERE player_guid = ?').bind(input.playerGuid))
    if (fp.activeRuns) {
      for (const [key, run] of Object.entries(fp.activeRuns)) {
        if (!run) continue
        const parts = key.replace('xefig:run:', '').split(':')
        stmts.push(
          db
            .prepare('INSERT INTO player_active_runs (player_guid, puzzle_date, game_mode, run_state, elapsed_ms, difficulty, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(
              input.playerGuid,
              parts[0] || run.puzzleDate || '',
              parts[1] || run.gameMode || '',
              JSON.stringify(run.puzzleState || {}),
              run.elapsedActiveMs || 0,
              run.difficulty || null,
              run.imageUrl || null,
              run.updatedAt || '',
            ),
        )
      }
    }
  } else {
    // Granular updates

    if (input.settings) {
      const sets: string[] = []
      const binds: unknown[] = []
      if (input.settings.profileName !== undefined) {
        sets.push('profile_name = ?')
        binds.push(input.settings.profileName)
      }
      if (input.settings.boardColorIndex !== undefined) {
        sets.push('board_color_index = ?')
        binds.push(input.settings.boardColorIndex)
      }
      if (sets.length > 0) {
        sets.push("updated_at = datetime('now')")
        stmts.push(
          db.prepare(`UPDATE player_profiles SET ${sets.join(', ')} WHERE player_guid = ?`).bind(...binds, input.playerGuid),
        )
      }
    }

    if (input.completedRun) {
      const cr = input.completedRun
      stmts.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO player_completed (player_guid, puzzle_date, game_mode, difficulty, elapsed_ms, best_ms, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(input.playerGuid, cr.puzzleDate, cr.gameMode, cr.difficulty || null, cr.elapsedActiveMs, cr.bestElapsedMs, cr.completedAt),
      )
    }

    if (input.activeRun) {
      const ar = input.activeRun
      stmts.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO player_active_runs (player_guid, puzzle_date, game_mode, run_state, elapsed_ms, difficulty, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(input.playerGuid, ar.puzzleDate, ar.gameMode, JSON.stringify(ar.puzzleState || {}), ar.elapsedActiveMs, ar.difficulty || null, ar.imageUrl || null, ar.updatedAt),
      )
    }

    // Bump updated_at if we didn't already via settings
    if (!input.settings && stmts.length > 0) {
      stmts.push(
        db.prepare("UPDATE player_profiles SET updated_at = datetime('now') WHERE player_guid = ?").bind(input.playerGuid),
      )
    }
  }

  if (stmts.length === 0) {
    return { ok: true, updatedAt: existing.updated_at }
  }

  // Batch in chunks
  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50))
  }

  const updated = await db
    .prepare('SELECT updated_at FROM player_profiles WHERE player_guid = ?')
    .bind(input.playerGuid)
    .first<{ updated_at: string }>()

  return { ok: true, updatedAt: updated?.updated_at ?? '' }
}

export async function pullProfile(
  db: D1Database,
  playerGuid: string,
): Promise<AssembledProfile | null> {
  await ensureSyncTables(db)

  if (!isValidPlayerGuid(playerGuid)) {
    throw new Error('Invalid playerGuid.')
  }

  return assembleProfile(db, playerGuid)
}
