-- 0003: conversations with HELIOS, approvals, and the record of cloud calls.

-- One conversation. 'helios' ones happen here; 'claude_import' ones are
-- brought in from a Claude export (phase 3).
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL DEFAULT 'helios' CHECK (source IN ('helios', 'claude_import')),
  channel         TEXT NOT NULL DEFAULT 'text' CHECK (channel IN ('text', 'voice')),
  title           TEXT NOT NULL DEFAULT '',
  external_id     TEXT UNIQUE,
  summary         TEXT,
  started_at      TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  deleted_at      TEXT
) STRICT;
CREATE INDEX conversations_recent ON conversations (last_message_at) WHERE deleted_at IS NULL;

-- The transcript. `text` is what was said, searchable. `content` keeps the
-- model's full answer exactly as the provider returned it (tool requests,
-- reasoning blocks), so a conversation can be continued without loss.
-- `sensitivity` is the highest label of anything the message contains; it
-- decides whether the message may be sent to a cloud model.
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id),
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  text            TEXT NOT NULL DEFAULT '',
  content         TEXT CHECK (content IS NULL OR json_valid(content)),
  sensitivity     TEXT NOT NULL DEFAULT 'private' CHECK (sensitivity IN ('normal', 'private', 'sensitive', 'secret')),
  provider        TEXT,
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
) STRICT;

-- A transcript is a record of what happened. It is never rewritten.
CREATE TRIGGER messages_no_update BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'messages are never rewritten');
END;

-- Every time HELIOS needed a yes: an action above tier 0, or sensitive
-- context about to go to a cloud model. `action` is the exact, validated
-- request that runs if the owner approves; nothing else can run from it.
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('tool', 'cloud_egress')),
  tier            INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 3),
  summary         TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (json_valid(action)),
  conversation_id TEXT REFERENCES conversations (id),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  requested_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_at      TEXT,
  decided_via     TEXT,
  result          TEXT
) STRICT;
CREATE INDEX approvals_pending ON approvals (status, requested_at);

-- Every call to a cloud model, and every call that was held back. This is
-- the answer to "what left this machine, when, and who allowed it?".
-- cost_micros is millionths of a US dollar.
CREATE TABLE egress_log (
  id              TEXT PRIMARY KEY,
  at              TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  max_sensitivity TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  cost_micros     INTEGER NOT NULL DEFAULT 0,
  outcome         TEXT NOT NULL CHECK (outcome IN ('sent', 'held_for_approval', 'blocked_by_cap', 'failed')),
  approval_id     TEXT REFERENCES approvals (id),
  conversation_id TEXT REFERENCES conversations (id)
) STRICT;
CREATE INDEX egress_log_at ON egress_log (at);
