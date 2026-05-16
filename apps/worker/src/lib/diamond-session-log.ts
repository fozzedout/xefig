// Diamond (paint) session logs uploaded from the client on completion.
// The client also keeps a localStorage copy; the remote row is what
// makes the log reviewable in admin from any device.

let tableReady = false

export async function ensureDiamondSessionLogTable(db: D1Database): Promise<void> {
  if (tableReady) return
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS diamond_session_logs (
        puzzle_date TEXT NOT NULL,
        player_guid TEXT NOT NULL,
        elapsed_active_ms INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        log_json TEXT NOT NULL,
        uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (puzzle_date, player_guid)
      )`,
    )
    .run()
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_diamond_session_logs_date
       ON diamond_session_logs (puzzle_date, uploaded_at DESC)`,
    )
    .run()
  tableReady = true
}

// 700 KB ceiling on the stored JSON. Typical sessions produce well
// under 200 KB; this leaves headroom for unusually busy grids without
// risking D1's per-row limits.
export const MAX_LOG_JSON_BYTES = 700 * 1024
