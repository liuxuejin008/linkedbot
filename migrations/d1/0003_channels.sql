-- LinkedBot: rename bot -> channel, add proxy/sendbox modes
-- Fresh schema rebuild (development only; drops all existing data)

DROP TABLE IF EXISTS forward_log;
DROP TABLE IF EXISTS bot_forwards;
DROP TABLE IF EXISTS bot_rules;
DROP TABLE IF EXISTS bot_members;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS bots;

-- Channels (was: bots)
CREATE TABLE IF NOT EXISTS channels (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  avatar_url      TEXT,
  webhook_secret  TEXT    NOT NULL UNIQUE,
  -- 'sendbox' | 'proxy'
  mode            TEXT    NOT NULL DEFAULT 'sendbox',
  -- JSON body returned to webhook caller in sendbox mode
  sendbox_response TEXT   NOT NULL DEFAULT '{"ok":true}',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channels_owner  ON channels(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_channels_secret ON channels(webhook_secret);

-- Messages (sendbox mode only)
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  payload_json TEXT    NOT NULL,
  headers_json TEXT,
  source_ip    TEXT,
  tag          TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  read_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread  ON messages(channel_id, read_at);

-- Filter rules per channel
CREATE TABLE IF NOT EXISTS channel_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  condition_type  TEXT    NOT NULL,
  condition_field TEXT,
  condition_op    TEXT    NOT NULL,
  condition_value TEXT,
  action          TEXT    NOT NULL,
  tag_value       TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_rules ON channel_rules(channel_id, priority);

-- Forwarding targets per channel (sendbox mode)
CREATE TABLE IF NOT EXISTS channel_forwards (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id         INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  url                TEXT    NOT NULL,
  method             TEXT    NOT NULL DEFAULT 'POST',
  extra_headers_json TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  retry_max          INTEGER NOT NULL DEFAULT 3,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_channel_forwards ON channel_forwards(channel_id);

-- Forwarding attempt log
CREATE TABLE IF NOT EXISTS forward_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  forward_id    INTEGER NOT NULL REFERENCES channel_forwards(id) ON DELETE CASCADE,
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

-- Team members
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL DEFAULT 'member',
  invited_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

-- Proxy requests (proxy mode: holds pending request/response pairs)
CREATE TABLE IF NOT EXISTS proxy_requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id            INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  payload_json          TEXT    NOT NULL DEFAULT '{}',
  headers_json          TEXT,
  source_ip             TEXT,
  status                TEXT    NOT NULL DEFAULT 'pending',
  response_body         TEXT,
  response_status       INTEGER DEFAULT 200,
  response_headers_json TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  completed_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_proxy_pending ON proxy_requests(channel_id, status, created_at);
