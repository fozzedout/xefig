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
