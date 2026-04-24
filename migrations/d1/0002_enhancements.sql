-- LinkedBot enhancement migration

-- 1. Add tag column to messages
ALTER TABLE messages ADD COLUMN tag TEXT;

-- 2. Message filter rules per bot
CREATE TABLE IF NOT EXISTS bot_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id          INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  -- condition_type: 'header' | 'payload_key' | 'source_ip' | 'content_type'
  condition_type  TEXT    NOT NULL,
  condition_field TEXT,
  -- condition_op: 'equals' | 'contains' | 'regex' | 'exists'
  condition_op    TEXT    NOT NULL,
  condition_value TEXT,
  -- action: 'accept' | 'reject' | 'tag'
  action          TEXT    NOT NULL,
  tag_value       TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_rules_bot ON bot_rules(bot_id, priority);

-- 3. Webhook forwarding targets per bot
CREATE TABLE IF NOT EXISTS bot_forwards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id             INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  url                TEXT    NOT NULL,
  method             TEXT    NOT NULL DEFAULT 'POST',
  extra_headers_json TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  retry_max          INTEGER NOT NULL DEFAULT 3,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_forwards_bot ON bot_forwards(bot_id);

-- 4. Forwarding attempt log
CREATE TABLE IF NOT EXISTS forward_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  forward_id    INTEGER NOT NULL REFERENCES bot_forwards(id) ON DELETE CASCADE,
  attempt       INTEGER NOT NULL DEFAULT 1,
  status_code   INTEGER,
  error         TEXT,
  next_retry_at TEXT,
  delivered_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_forward_log_pending
  ON forward_log(next_retry_at)
  WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_forward_log_message ON forward_log(message_id);

-- 5. Team members (additional access beyond owner)
CREATE TABLE IF NOT EXISTS bot_members (
  bot_id     INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- role: 'owner' | 'member' | 'readonly'
  role       TEXT    NOT NULL DEFAULT 'member',
  invited_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bot_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_members_user ON bot_members(user_id);
