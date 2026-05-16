// Diamond test-mode session logs. Kept in a separate table from real
// plays so calibration runs against the bundled hero image can never
// pollute production analytics, leaderboards, or completion stats.
// One row per (test_id, player_guid) — test_id is a client-supplied
// label (e.g. an ISO timestamp) so every test run gets its own row
// instead of overwriting the previous one.

let tableReady = false

export async function ensureDiamondTestSessionLogTable(db: D1Database): Promise<void> {
  if (tableReady) return
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS diamond_test_session_logs (
        test_id TEXT NOT NULL,
        player_guid TEXT NOT NULL,
        elapsed_active_ms INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        log_json TEXT NOT NULL,
        uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (test_id, player_guid)
      )`,
    )
    .run()
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_diamond_test_session_logs_uploaded
       ON diamond_test_session_logs (uploaded_at DESC)`,
    )
    .run()
  tableReady = true
}

export const TEST_LOG_MAX_JSON_BYTES = 700 * 1024

// Accept any non-empty short alphanumeric/punct string as a test_id.
// Clients use a "test-<ISO>" label by default but anything stable is
// fine — this is opaque to the server.
export function isValidTestId(value: string): boolean {
  return /^[0-9A-Za-z._:-]{1,80}$/.test(value)
}
