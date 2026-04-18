import {
  LEADERBOARD_DIFFICULTIES,
  LEADERBOARD_GAME_MODES,
  type LeaderboardDifficulty,
  type LeaderboardGameMode,
} from '../types'

let leaderboardTableReady = false

export async function ensureLeaderboardTable(db: D1Database): Promise<void> {
  if (leaderboardTableReady) {
    return
  }

  const table = await db
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'table' AND name = 'puzzle_leaderboard'
       LIMIT 1`,
    )
    .first<{ name: string; sql: string | null }>()

  if (!table) {
    await createLeaderboardTable(db)
  } else {
    const columns = await db.prepare(`PRAGMA table_info(puzzle_leaderboard)`).all<{ name: string }>()
    const hasGameMode = (columns.results || []).some((column) => column.name === 'game_mode')
    const hasModeScopedUnique =
      /UNIQUE\s*\(\s*puzzle_date\s*,\s*difficulty\s*,\s*game_mode\s*,\s*player_guid\s*\)/i.test(
        table.sql || '',
      )
    const hasSwapGameMode = /game_mode\s+IN\s*\([^)]*'swap'/i.test(table.sql || '')
    const hasPolygramGameMode = /game_mode\s+IN\s*\([^)]*'polygram'/i.test(table.sql || '')
    const hasDiamondGameMode = /game_mode\s+IN\s*\([^)]*'diamond'/i.test(table.sql || '')

    if (!hasGameMode || !hasModeScopedUnique || !hasSwapGameMode || !hasPolygramGameMode || !hasDiamondGameMode) {
      await db.prepare(`DROP TABLE IF EXISTS puzzle_leaderboard_next`).run()
      await createLeaderboardTable(db, 'puzzle_leaderboard_next')
      const selectGameModeExpr = hasGameMode ? `COALESCE(game_mode, 'jigsaw')` : `'jigsaw'`
      await db
        .prepare(
          `INSERT INTO puzzle_leaderboard_next (
             id, puzzle_date, difficulty, game_mode, player_guid, elapsed_ms, submitted_at
           )
           SELECT
             id, puzzle_date, difficulty, ${selectGameModeExpr}, player_guid, elapsed_ms, submitted_at
           FROM puzzle_leaderboard`,
        )
        .run()
      await db.prepare(`DROP TABLE puzzle_leaderboard`).run()
      await db.prepare(`ALTER TABLE puzzle_leaderboard_next RENAME TO puzzle_leaderboard`).run()
    }
  }

  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_puzzle_leaderboard_daily
       ON puzzle_leaderboard (puzzle_date, difficulty, game_mode, elapsed_ms, submitted_at)`,
    )
    .run()

  leaderboardTableReady = true
}

export function isLeaderboardDifficulty(value: string): value is LeaderboardDifficulty {
  return LEADERBOARD_DIFFICULTIES.includes(value as LeaderboardDifficulty)
}

export function isLeaderboardGameMode(value: string): value is LeaderboardGameMode {
  return LEADERBOARD_GAME_MODES.includes(value as LeaderboardGameMode)
}

async function createLeaderboardTable(
  db: D1Database,
  tableName = 'puzzle_leaderboard',
): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${tableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        puzzle_date TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        game_mode TEXT NOT NULL DEFAULT 'jigsaw' CHECK (game_mode IN ('jigsaw', 'sliding', 'swap', 'polygram', 'diamond')),
        player_guid TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms > 0),
        submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (puzzle_date, difficulty, game_mode, player_guid)
      )`,
    )
    .run()
}

// Append-only log of every leaderboard submission. Not read from the
// hot path (leaderboard queries still hit puzzle_leaderboard's
// one-row-per-player best-time snapshot); used for attempt counts,
// improvement deltas, streaks, replay analytics, and fraud signals.
let submissionsTableReady = false
export async function ensureSubmissionsTable(db: D1Database): Promise<void> {
  if (submissionsTableReady) return
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS puzzle_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        puzzle_date TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        game_mode TEXT NOT NULL CHECK (game_mode IN ('jigsaw', 'sliding', 'swap', 'polygram', 'diamond')),
        player_guid TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms > 0),
        submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    )
    .run()
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_puzzle_submissions_player
       ON puzzle_submissions (player_guid, submitted_at DESC)`,
    )
    .run()
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_puzzle_submissions_puzzle
       ON puzzle_submissions (puzzle_date, game_mode, difficulty, submitted_at DESC)`,
    )
    .run()
  submissionsTableReady = true
}
