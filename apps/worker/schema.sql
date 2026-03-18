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
    player_guid TEXT NOT NULL,
    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms > 0),
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (puzzle_date, difficulty, player_guid)
);

CREATE INDEX IF NOT EXISTS idx_puzzle_leaderboard_daily
ON puzzle_leaderboard (puzzle_date, difficulty, elapsed_ms, submitted_at);
