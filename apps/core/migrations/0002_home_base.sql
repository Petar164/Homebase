-- 0002: the Home Base records (planning, training, money, analytics).
-- Calendar days are 'YYYY-MM-DD', clock times 'HH:MM', money whole cents.

CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  area       TEXT NOT NULL DEFAULT 'inbox',
  due        TEXT,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  done_at    TEXT,
  note       TEXT,
  repeat     TEXT CHECK (repeat IN ('weekly', 'monthly')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX tasks_open ON tasks (done, due) WHERE deleted_at IS NULL;

CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'activity' CHECK (category IN ('activity', 'gym', 'mma')),
  date       TEXT NOT NULL,
  start_time TEXT,
  end_time   TEXT,
  weekly     INTEGER NOT NULL DEFAULT 0 CHECK (weekly IN (0, 1)),
  until      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX events_date ON events (date) WHERE deleted_at IS NULL;

CREATE TABLE training_sessions (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  time       TEXT,
  kind       TEXT NOT NULL CHECK (kind IN ('gym', 'mma')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX training_sessions_date ON training_sessions (date) WHERE deleted_at IS NULL;

-- Money in or out that is not a shop sale: expenses, personal spending,
-- imported bank rows. dedupe_key stops the same bank line landing twice.
CREATE TABLE ledger_entries (
  id              TEXT PRIMARY KEY,
  date            TEXT NOT NULL,
  description     TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 0),
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  area            TEXT NOT NULL DEFAULT 'unsorted' CHECK (area IN ('unsorted', 'business', 'personal', 'school', 'transfer')),
  category        TEXT,
  vat_reclaimable INTEGER NOT NULL DEFAULT 0 CHECK (vat_reclaimable IN (0, 1)),
  dedupe_key      TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
) STRICT;
CREATE INDEX ledger_entries_date ON ledger_entries (date) WHERE deleted_at IS NULL;

-- Something bought to resell. Entered once; logging the sale later is
-- picking it from this list.
CREATE TABLE stock_items (
  id                   TEXT PRIMARY KEY,
  description          TEXT NOT NULL,
  purchase_price_cents INTEGER NOT NULL CHECK (purchase_price_cents >= 0),
  purchase_date        TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
) STRICT;

-- A customer. Personal data: it exists only in the database and is never
-- sent to a cloud model without approval (see docs/SECURITY.md).
CREATE TABLE buyers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL DEFAULT '',
  street      TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;

-- One item sold. invoice_number (FV-0001-2026) is unique, so two sales can
-- never share one. A sale is 'complete' only when every invoice field is
-- filled in; the core enforces that rule.
CREATE TABLE sales (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,
  description       TEXT NOT NULL,
  price_cents       INTEGER NOT NULL CHECK (price_cents >= 0),
  cost_cents        INTEGER CHECK (cost_cents >= 0),
  shipping_cents    INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  other_costs_cents INTEGER NOT NULL DEFAULT 0 CHECK (other_costs_cents >= 0),
  region            TEXT NOT NULL DEFAULT 'NL' CHECK (region IN ('NL', 'EU', 'world')),
  method            TEXT NOT NULL DEFAULT 'Website',
  invoice_number    TEXT UNIQUE,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'complete')),
  buyer_id          TEXT REFERENCES buyers (id) ON DELETE SET NULL,
  stock_item_id     TEXT UNIQUE REFERENCES stock_items (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
) STRICT;
CREATE INDEX sales_date ON sales (date) WHERE deleted_at IS NULL;

-- Follower counts over time. log is JSON: [{ "d": "2026-01-31", "n": 1200 }]
CREATE TABLE social_accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  goal       INTEGER NOT NULL DEFAULT 0,
  log        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(log)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
