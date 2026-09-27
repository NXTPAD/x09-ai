-- X09 AI database schema (Cloudflare D1)

CREATE TABLE IF NOT EXISTS users (
  id                     TEXT PRIMARY KEY,
  email                  TEXT NOT NULL UNIQUE,
  pass_hash              TEXT NOT NULL,
  pass_salt              TEXT NOT NULL,
  plan                   TEXT,                -- NULL (no active plan) | 'pilot' | 'commander' | 'fleet'
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  sub_status             TEXT,
  current_period_end     INTEGER,
  created_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users(stripe_customer_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  period  TEXT NOT NULL,          -- YYYY-MM (UTC calendar month)
  fast    INTEGER NOT NULL DEFAULT 0,
  deep    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

CREATE TABLE IF NOT EXISTS threads (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,       -- 'user' | 'assistant'
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
