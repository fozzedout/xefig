CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_date TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('jigsaw', 'slider', 'swap', 'polygram', 'diamond')),
    account_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    moves INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_date_category
ON leaderboard_entries (puzzle_date, category);

CREATE INDEX IF NOT EXISTS idx_leaderboard_account
ON leaderboard_entries (account_id);

CREATE TABLE IF NOT EXISTS puzzle_leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_date TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    game_mode TEXT NOT NULL DEFAULT 'jigsaw' CHECK (game_mode IN ('jigsaw', 'sliding', 'swap', 'polygram', 'diamond')),
    player_guid TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms > 0),
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (puzzle_date, difficulty, game_mode, player_guid)
);

CREATE INDEX IF NOT EXISTS idx_puzzle_leaderboard_daily
ON puzzle_leaderboard (puzzle_date, difficulty, game_mode, elapsed_ms, submitted_at);

CREATE TABLE IF NOT EXISTS player_profiles (
    player_guid TEXT PRIMARY KEY,
    share_code TEXT NOT NULL UNIQUE,
    profile_name TEXT NOT NULL DEFAULT '',
    board_color_index INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_completed (
    player_guid TEXT NOT NULL,
    puzzle_date TEXT NOT NULL,
    game_mode TEXT NOT NULL,
    difficulty TEXT,
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    best_ms INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (player_guid, puzzle_date, game_mode)
);

CREATE TABLE IF NOT EXISTS player_active_runs (
    player_guid TEXT NOT NULL,
    puzzle_date TEXT NOT NULL,
    game_mode TEXT NOT NULL,
    run_state TEXT NOT NULL DEFAULT '{}',
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    difficulty TEXT,
    image_url TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (player_guid, puzzle_date, game_mode)
);

-- Append-only log of every leaderboard submission. Not read on the
-- leaderboard hot path (puzzle_leaderboard still holds the one-row-
-- per-player best-time snapshot). Used for attempt counts, improvement
-- deltas, streaks, and replay analytics.
CREATE TABLE IF NOT EXISTS puzzle_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_date TEXT NOT NULL,
    difficulty TEXT NOT NULL,
    game_mode TEXT NOT NULL CHECK (game_mode IN ('jigsaw', 'sliding', 'swap', 'polygram', 'diamond')),
    player_guid TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms > 0),
    submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_puzzle_submissions_player
ON puzzle_submissions (player_guid, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_puzzle_submissions_puzzle
ON puzzle_submissions (puzzle_date, game_mode, difficulty, submitted_at DESC);
