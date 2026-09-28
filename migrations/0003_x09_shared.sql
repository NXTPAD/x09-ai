-- ============================================================
--  X09 shared database (x09-db) — one account across X09 Hub, X09 AI and X09 Docs.
--  This migrations folder is IDENTICAL in all three repos, so whichever site deploys
--  first applies it and the others see it as already applied.
-- ============================================================

-- Profile fields shown on every X09 site
ALTER TABLE users ADD COLUMN avatar  TEXT;      -- small data: URL (PNG/JPEG/WebP)
ALTER TABLE users ADD COLUMN company TEXT;

-- One row per (user, product). Replaces users.plan / users.sub_status (kept only for history).
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product                TEXT NOT NULL,       -- 'ai' | 'docs'
  plan                   TEXT,                -- plan key inside that product, e.g. 'commander', 'pro'
  status                 TEXT,                -- Stripe subscription status
  stripe_subscription_id TEXT,
  current_period_end     INTEGER,
  updated_at             INTEGER NOT NULL,
  PRIMARY KEY (user_id, product)
);
CREATE INDEX IF NOT EXISTS idx_subs_stripe ON subscriptions(stripe_subscription_id);

-- Carry over existing X09 AI subscriptions
INSERT OR IGNORE INTO subscriptions (user_id, product, plan, status, stripe_subscription_id, current_period_end, updated_at)
  SELECT id, 'ai', plan, sub_status, stripe_subscription_id, current_period_end, created_at
  FROM users WHERE stripe_subscription_id IS NOT NULL;

-- Monthly usage counters for every product live in one row per user per month
ALTER TABLE usage ADD COLUMN docs  INTEGER NOT NULL DEFAULT 0;   -- X09 Docs AI drafts/rewrites
ALTER TABLE usage ADD COLUMN guide INTEGER NOT NULL DEFAULT 0;   -- X09 Hub "Ask X09" questions

-- ---------- X09 Docs ----------
-- The business shown on every document (one per account)
CREATE TABLE IF NOT EXISTS business (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data         TEXT NOT NULL,
  logo         TEXT,
  updated_at   INTEGER NOT NULL
);

-- Next document number per type
CREATE TABLE IF NOT EXISTS counters (
  user_id TEXT NOT NULL,
  type    TEXT NOT NULL,
  next    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, type)
);

CREATE TABLE IF NOT EXISTS docs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  number       TEXT NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  client_name  TEXT,
  client_email TEXT,
  total        REAL NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'USD',
  data         TEXT NOT NULL,
  share_id     TEXT NOT NULL UNIQUE,
  signer_name  TEXT,
  signed_at    INTEGER,
  sign_ip      TEXT,
  viewed_at    INTEGER,
  paid_at      INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_user ON docs(user_id, updated_at DESC);

-- Small key/value settings (e.g. the Stripe Customer Portal configuration id)
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
