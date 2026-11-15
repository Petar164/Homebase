-- 0001: identity, the owner account, sessions, the audit log and history.
-- Applied migrations are never edited. To change the schema, add a new file.

-- Identity of this database (instance id, creation date).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Owner preferences. One row per setting; the value is JSON.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;

-- There is exactly one account. It is created from the command line on the
-- machine itself; there is no sign-up route.
CREATE TABLE owner (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

-- A logged-in browser or device. The cookie holds a random token; only its
-- SHA-256 hash is stored, so a leaked database cannot be used to log in.
-- elevated_until is set after the owner re-proves who they are, and allows
-- sensitive actions for a few minutes.
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  elevated_until TEXT
) STRICT;
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Every login attempt, for rate limiting and lockout.
CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL,
  succeeded  INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX login_attempts_key ON login_attempts (key, created_at);

-- What happened, in order. Each entry carries the hash of the entry before
-- it, so removing or editing one breaks the chain. The triggers make the
-- table append-only even for code inside this app.
CREATE TABLE audit_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT NOT NULL DEFAULT '',
  detail    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
) STRICT;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- The previous version of every edited or deleted record, so a single wrong
-- edit can be undone without restoring a whole snapshot.
CREATE TABLE record_revisions (
  id         INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id     TEXT NOT NULL,
  change     TEXT NOT NULL CHECK (change IN ('update', 'delete')),
  data       TEXT NOT NULL CHECK (json_valid(data)),
  actor      TEXT NOT NULL,
  changed_at TEXT NOT NULL
) STRICT;
CREATE INDEX record_revisions_row ON record_revisions (table_name, row_id, changed_at);

-- Scheduler state that must survive restarts.
CREATE TABLE jobs (
  name        TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_status TEXT,
  last_error  TEXT
) STRICT;
