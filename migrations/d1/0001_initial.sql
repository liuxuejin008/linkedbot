-- LinkedBot D1 schema (SQLite)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  avatar_url      TEXT,
  webhook_secret  TEXT    NOT NULL UNIQUE,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_bots_secret ON bots(webhook_secret);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id       INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  payload_json TEXT    NOT NULL,
  headers_json TEXT,
  source_ip    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  read_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_bot ON messages(bot_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(bot_id, read_at);
