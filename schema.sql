-- AI Pro Pass store database (Cloudflare D1)
-- Run once in Cloudflare: D1 > aipropass-db > Console > paste this > Execute

CREATE TABLE IF NOT EXISTS links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  url            TEXT    NOT NULL UNIQUE,         -- the activation link you sell
  status         TEXT    NOT NULL DEFAULT 'available', -- available | reserved | sold | disabled
  reservation    TEXT,                            -- token of the checkout holding it
  reserved_until INTEGER,                         -- unix seconds; after this it is free again
  reserved_ip    TEXT,
  session_id     TEXT,                            -- Stripe Checkout session that bought it
  sold_at        INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_links_status ON links(status, id);
CREATE INDEX IF NOT EXISTS idx_links_reservation ON links(reservation);

CREATE TABLE IF NOT EXISTS orders (
  session_id   TEXT PRIMARY KEY,                  -- Stripe Checkout session id
  link_id      INTEGER,
  email        TEXT,
  name         TEXT,
  amount       INTEGER,                           -- in cents
  currency     TEXT,
  status       TEXT NOT NULL,                     -- processing | delivered | needs_attention
  emailed      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
