CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    puzzle_date TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('jigsaw', 'slider', 'swap', 'polygram')),
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
    game_mode TEXT NOT NULL DEFAULT 'jigsaw' CHECK (game_mode IN ('jigsaw', 'sliding', 'swap', 'polygram')),
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

CREATE TABLE IF NOT EXISTS player_sync_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_guid TEXT NOT NULL,
    revision INTEGER NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('settings', 'completed', 'active', 'active_deleted')),
    entity_key TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_player_sync_changes_guid_id
ON player_sync_changes (player_guid, id);
