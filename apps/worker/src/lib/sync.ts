const SHARE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const SHARE_CODE_LENGTH = 6

let tablesReady = false

export type SyncSettings = {
  profileName: string
  boardColorIndex: number
}

export type CompletedRunEntry = {
  puzzleDate: string
  gameMode: string
  difficulty?: string | null
  elapsedActiveMs: number
  bestElapsedMs: number
  completedAt: string
}

export type ActiveRunEntry = {
  puzzleDate: string
  gameMode: string
  difficulty?: string | null
  imageUrl?: string | null
  elapsedActiveMs: number
  puzzleState: unknown
  updatedAt: string
}

export type DeletedActiveRunEntry = {
  puzzleDate: string
  gameMode: string
  deletedAt: string
}

type ProfileRow = {
  profile_name: string
  board_color_index: number
  revision: number
  updated_at: string
}

export type AssembledProfile = {
  settings: SyncSettings
  completedRuns: Record<string, Record<string, { difficulty: string | null; elapsedActiveMs: number; bestElapsedMs: number; completedAt: string }>>
  activeRuns: Record<string, { puzzleDate: string; gameMode: string; difficulty: string | null; imageUrl: string | null; elapsedActiveMs: number; puzzleState: unknown; updatedAt: string }>
  updatedAt: string
  revision: number
}

export type PushInput = {
  playerGuid: string
  baseRevision: number | null
  settings?: { profileName?: string; boardColorIndex?: number }
  completedRuns?: CompletedRunEntry[]
  activeRuns?: ActiveRunEntry[]
  deletedActiveRuns?: DeletedActiveRunEntry[]
}

export type PullResult =
  | { noChanges: true; revision: number }
  | ({ fullSync: true } & AssembledProfile)

function makeEntityKey(puzzleDate: string, gameMode: string): string {
  return `${puzzleDate}:${gameMode}`
}

export function compareIsoTimestamps(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ? Date.parse(a) : Number.NaN
  const right = b ? Date.parse(b) : Number.NaN
  if (!Number.isFinite(left) && !Number.isFinite(right)) return 0
  if (!Number.isFinite(left)) return -1
  if (!Number.isFinite(right)) return 1
  if (left === right) return 0
  return left > right ? 1 : -1
}

export function mergeCompletedEntry(
  localEntry: { difficulty?: string | null; elapsedActiveMs?: number; bestElapsedMs?: number; completedAt?: string } | null | undefined,
  remoteEntry: { difficulty?: string | null; elapsedActiveMs?: number; bestElapsedMs?: number; completedAt?: string } | null | undefined,
): { difficulty: string | null; elapsedActiveMs: number; bestElapsedMs: number; completedAt: string } | null {
  if (!localEntry && !remoteEntry) return null
  if (!localEntry) {
    return {
      difficulty: remoteEntry?.difficulty ?? null,
      elapsedActiveMs: Number(remoteEntry?.elapsedActiveMs) || 0,
      bestElapsedMs: Number(remoteEntry?.bestElapsedMs ?? remoteEntry?.elapsedActiveMs) || 0,
      completedAt: remoteEntry?.completedAt || '',
    }
  }
  if (!remoteEntry) {
    return {
      difficulty: localEntry.difficulty ?? null,
      elapsedActiveMs: Number(localEntry.elapsedActiveMs) || 0,
      bestElapsedMs: Number(localEntry.bestElapsedMs ?? localEntry.elapsedActiveMs) || 0,
      completedAt: localEntry.completedAt || '',
    }
  }

  const localElapsed = Number(localEntry.elapsedActiveMs) || 0
  const remoteElapsed = Number(remoteEntry.elapsedActiveMs) || 0
  const rawLocalBest = Number(localEntry.bestElapsedMs ?? localElapsed) || 0
  const rawRemoteBest = Number(remoteEntry.bestElapsedMs ?? remoteElapsed) || 0
  // Treat sub-second bests as absent — they're artifacts of the pre-fix
  // timer race and shouldn't poison the merge by being picked as the
  // "faster" value via Math.min.
  const localBest = rawLocalBest >= 1000 ? rawLocalBest : 0
  const remoteBest = rawRemoteBest >= 1000 ? rawRemoteBest : 0
  const cmp = compareIsoTimestamps(localEntry.completedAt, remoteEntry.completedAt)
  const newer = cmp >= 0 ? localEntry : remoteEntry

  return {
    difficulty: newer.difficulty ?? localEntry.difficulty ?? remoteEntry.difficulty ?? null,
    elapsedActiveMs: cmp >= 0 ? localElapsed : remoteElapsed,
    bestElapsedMs: Math.min(localBest || remoteBest, remoteBest || localBest),
    completedAt: cmp >= 0 ? localEntry.completedAt || remoteEntry.completedAt || '' : remoteEntry.completedAt || localEntry.completedAt || '',
  }
}

export async function ensureSyncTables(db: D1Database): Promise<void> {
  if (tablesReady) return

  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_profiles (player_guid TEXT PRIMARY KEY, share_code TEXT NOT NULL UNIQUE, profile_name TEXT NOT NULL DEFAULT '', board_color_index INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_completed (player_guid TEXT NOT NULL, puzzle_date TEXT NOT NULL, game_mode TEXT NOT NULL, difficulty TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0, best_ms INTEGER NOT NULL DEFAULT 0, completed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (player_guid, puzzle_date, game_mode))`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS player_active_runs (player_guid TEXT NOT NULL, puzzle_date TEXT NOT NULL, game_mode TEXT NOT NULL, run_state TEXT NOT NULL DEFAULT '{}', elapsed_ms INTEGER NOT NULL DEFAULT 0, difficulty TEXT, image_url TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (player_guid, puzzle_date, game_mode))`,
    ),
  ])

  try {
    const cols = await db
      .prepare(`SELECT name FROM pragma_table_info('player_profiles')`)
      .all<{ name: string }>()
    const colNames = new Set((cols.results || []).map((row) => row.name))

    if (!colNames.has('profile_name')) {
      try { await db.prepare(`ALTER TABLE player_profiles ADD COLUMN profile_name TEXT NOT NULL DEFAULT ''`).run() } catch {}
    }
    if (!colNames.has('board_color_index')) {
      try { await db.prepare(`ALTER TABLE player_profiles ADD COLUMN board_color_index INTEGER NOT NULL DEFAULT 0`).run() } catch {}
    }
    if (!colNames.has('revision')) {
      try { await db.prepare(`ALTER TABLE player_profiles ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`).run() } catch {}
    }

    if (colNames.has('profile_data')) {
      await migrateFromJsonBlob(db)
    }
  } catch {
    // Best-effort migration only.
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

      if (data.profileName || data.boardColorIndex) {
        stmts.push(
          db
            .prepare(`UPDATE player_profiles SET profile_name = ?, board_color_index = ? WHERE player_guid = ?`)
            .bind(data.profileName || '', data.boardColorIndex || 0, row.player_guid),
        )
      }

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

      for (let i = 0; i < stmts.length; i += 50) {
        await db.batch(stmts.slice(i, i + 50))
      }
    } catch {
      // Skip invalid historical blobs.
    }
  }

  try {
    await db.prepare(`ALTER TABLE player_profiles DROP COLUMN profile_data`).run()
  } catch {
    // Some SQLite variants do not support DROP COLUMN.
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

async function assembleProfile(db: D1Database, playerGuid: string): Promise<AssembledProfile | null> {
  const [profileResult, completedResult, activeResult] = await db.batch([
    db.prepare('SELECT profile_name, board_color_index, revision, updated_at FROM player_profiles WHERE player_guid = ?').bind(playerGuid),
    db.prepare('SELECT puzzle_date, game_mode, difficulty, elapsed_ms, best_ms, completed_at FROM player_completed WHERE player_guid = ?').bind(playerGuid),
    db.prepare('SELECT puzzle_date, game_mode, run_state, elapsed_ms, difficulty, image_url, updated_at FROM player_active_runs WHERE player_guid = ?').bind(playerGuid),
  ])

  const profile = profileResult.results?.[0] as ProfileRow | undefined
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
    revision: Number(profile.revision) || 0,
  }
}

export async function registerProfile(
  db: D1Database,
  playerGuid: string,
): Promise<{ shareCode: string; settings: object; completedRuns: object; activeRuns: object; updatedAt: string; revision: number }> {
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
      revision: assembled?.revision || 0,
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShareCode()
    try {
      const result = await db
        .prepare(
          `INSERT INTO player_profiles (player_guid, share_code, revision, updated_at, created_at) VALUES (?, ?, 0, datetime('now'), datetime('now')) RETURNING updated_at, revision`,
        )
        .bind(playerGuid, code)
        .first<{ updated_at: string; revision: number }>()

      return {
        shareCode: code,
        settings: { profileName: '', boardColorIndex: 0 },
        completedRuns: {},
        activeRuns: {},
        updatedAt: result?.updated_at ?? '',
        revision: Number(result?.revision) || 0,
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : ''
      if (msg.includes('UNIQUE') && attempt < 4) continue
      throw error
    }
  }

  throw new Error('Failed to generate unique share code.')
}

export async function linkProfile(
  db: D1Database,
  shareCode: string,
): Promise<{ playerGuid: string; settings: object; completedRuns: object; activeRuns: object; updatedAt: string; revision: number } | null> {
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
    revision: assembled.revision,
  }
}

export async function pushProfile(
  db: D1Database,
  input: PushInput,
): Promise<
  | { ok: true; updatedAt: string; revision: number }
  | { conflict: true; currentRevision: number }
  | { notFound: true }
> {
  await ensureSyncTables(db)

  if (!isValidPlayerGuid(input.playerGuid)) {
    throw new Error('Invalid playerGuid.')
  }

  const existing = await db
    .prepare('SELECT revision, updated_at FROM player_profiles WHERE player_guid = ?')
    .bind(input.playerGuid)
    .first<{ revision: number | string; updated_at: string }>()

  if (!existing) return { notFound: true }

  const currentRevision = Number(existing.revision) || 0
  const baseRevision = Number(input.baseRevision) || 0

  if (baseRevision !== currentRevision) {
    return { conflict: true, currentRevision }
  }

  const completedRuns = Array.isArray(input.completedRuns) ? input.completedRuns : []
  const activeRuns = Array.isArray(input.activeRuns) ? input.activeRuns : []
  const deletedActiveRuns = Array.isArray(input.deletedActiveRuns) ? input.deletedActiveRuns : []
  const hasSettings = Boolean(input.settings && (input.settings.profileName !== undefined || input.settings.boardColorIndex !== undefined))
  const hasChanges = hasSettings || completedRuns.length > 0 || activeRuns.length > 0 || deletedActiveRuns.length > 0

  if (!hasChanges) {
    return {
      ok: true,
      updatedAt: existing.updated_at,
      revision: currentRevision,
    }
  }

  const nextRevision = currentRevision + 1
  const currentProfile = await db
    .prepare('SELECT profile_name, board_color_index FROM player_profiles WHERE player_guid = ?')
    .bind(input.playerGuid)
    .first<{ profile_name: string; board_color_index: number | string }>()

  const profileName = input.settings?.profileName ?? currentProfile?.profile_name ?? ''
  const boardColorIndex = input.settings?.boardColorIndex ?? (Number(currentProfile?.board_color_index) || 0)

  const updatedProfile = await db
    .prepare(
      `UPDATE player_profiles
       SET profile_name = ?, board_color_index = ?, revision = ?, updated_at = datetime('now')
       WHERE player_guid = ? AND revision = ?
       RETURNING updated_at, revision`,
    )
    .bind(profileName, boardColorIndex, nextRevision, input.playerGuid, currentRevision)
    .first<{ updated_at: string; revision: number | string }>()

  if (!updatedProfile) {
    return { conflict: true, currentRevision: currentRevision + 1 }
  }

  const stmts: D1PreparedStatement[] = []

  const completedKeys = new Set<string>()
  for (const entry of completedRuns) {
    completedKeys.add(makeEntityKey(entry.puzzleDate, entry.gameMode))
    stmts.push(
      db
        .prepare(
          'INSERT OR REPLACE INTO player_completed (player_guid, puzzle_date, game_mode, difficulty, elapsed_ms, best_ms, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          input.playerGuid,
          entry.puzzleDate,
          entry.gameMode,
          entry.difficulty || null,
          entry.elapsedActiveMs,
          entry.bestElapsedMs,
          entry.completedAt,
        ),
    )
    stmts.push(
      db
        .prepare('DELETE FROM player_active_runs WHERE player_guid = ? AND puzzle_date = ? AND game_mode = ?')
        .bind(input.playerGuid, entry.puzzleDate, entry.gameMode),
    )
  }

  for (const entry of activeRuns) {
    if (completedKeys.has(makeEntityKey(entry.puzzleDate, entry.gameMode))) continue
    stmts.push(
      db
        .prepare(
          'INSERT OR REPLACE INTO player_active_runs (player_guid, puzzle_date, game_mode, run_state, elapsed_ms, difficulty, image_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          input.playerGuid,
          entry.puzzleDate,
          entry.gameMode,
          JSON.stringify(entry.puzzleState || {}),
          entry.elapsedActiveMs,
          entry.difficulty || null,
          entry.imageUrl || null,
          entry.updatedAt,
        ),
    )
  }

  for (const entry of deletedActiveRuns) {
    if (completedKeys.has(makeEntityKey(entry.puzzleDate, entry.gameMode))) continue
    stmts.push(
      db
        .prepare('DELETE FROM player_active_runs WHERE player_guid = ? AND puzzle_date = ? AND game_mode = ?')
        .bind(input.playerGuid, entry.puzzleDate, entry.gameMode),
    )
  }

  for (let i = 0; i < stmts.length; i += 50) {
    await db.batch(stmts.slice(i, i + 50))
  }

  return {
    ok: true,
    updatedAt: updatedProfile.updated_at,
    revision: Number(updatedProfile.revision) || nextRevision,
  }
}

export async function pullProfile(
  db: D1Database,
  playerGuid: string,
  knownRevision = 0,
): Promise<PullResult | null> {
  await ensureSyncTables(db)

  if (!isValidPlayerGuid(playerGuid)) {
    throw new Error('Invalid playerGuid.')
  }

  const profile = await db
    .prepare('SELECT revision FROM player_profiles WHERE player_guid = ?')
    .bind(playerGuid)
    .first<{ revision: number | string }>()

  if (!profile) return null

  const currentRevision = Number(profile.revision) || 0
  if (knownRevision > 0 && knownRevision >= currentRevision) {
    return { noChanges: true, revision: currentRevision }
  }

  const assembled = await assembleProfile(db, playerGuid)
  if (!assembled) return null
  return { ...assembled, fullSync: true }
}
