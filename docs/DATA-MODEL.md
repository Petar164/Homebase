# Data model

One SQLite database holds every record. Large things (documents, generated
files, images) are files in the data folder; the database holds their path,
hash and metadata.

## Conventions

- Ids are text. New rows get a time-ordered UUID (version 7).
- Timestamps are UTC text (`2026-11-15T02:10:00.000Z`). Calendar days are
  `YYYY-MM-DD`. Money is whole cents.
- Tables that people edit have `created_at`, `updated_at` and `deleted_at`
  (deleting marks the row; it does not remove it), and their old versions go
  to `record_revisions`.
- Content-bearing rows carry a `sensitivity` label (see
  [security](SECURITY.md)).
- Tables are added by migrations as each phase needs them. "Phase" below
  says when a table arrives.

## System and safety (phase 1)

| Table | Purpose | Key fields |
|---|---|---|
| `schema_migrations` | Which migrations ran | `version`, `name`, `checksum`, `applied_at`, `app_version` |
| `meta` | Identity of this database | `key`, `value` (instance id, creation date) |
| `settings` | Owner profile and preferences | `key`, `value` (JSON), `updated_at` |
| `owner` | The single account | `username`, `password_hash`, `created_at` |
| `sessions` | Logged-in browsers and devices | `token_hash`, `expires_at`, `last_seen_at`, `elevated_until`, `label` |
| `login_attempts` | Rate limiting and lockout | `key`, `succeeded`, `created_at` |
| `audit_log` | Append-only, hash-chained record of actions | `seq`, `at`, `actor`, `action`, `target`, `detail`, `prev_hash`, `hash` |
| `record_revisions` | Earlier versions of edited rows | `table_name`, `row_id`, `data`, `changed_at`, `actor` |
| `backups` | Index of snapshots (the backup store itself is the source of truth) | `id`, `kind`, `created_at`, `schema_version`, `bytes`, `verified_at`, `mirrors` |
| `jobs` | Scheduler state that must survive restarts | `name`, `last_run_at`, `last_status`, `next_due_at` |

## Home Base records (phase 1)

| Table | Purpose | Key fields |
|---|---|---|
| `tasks` | Things to do | `title`, `area`, `due`, `done`, `done_at`, `note`, `repeat`, `project_id` |
| `events` | Calendar items | `title`, `category`, `date`, `start_time`, `end_time`, `weekly`, `until` |
| `training_sessions` | Training log | `date`, `time`, `kind` |
| `ledger_entries` | Money in and out that is not a sale | `date`, `description`, `amount_cents`, `direction`, `area`, `category`, `vat_reclaimable`, `dedupe_key` |
| `stock_items` | Items bought to resell | `description`, `purchase_price_cents`, `purchase_date`, `source` |
| `buyers` | Customers (personal data, `sensitive`) | `name`, `email`, address fields |
| `sales` | One item sold | `date`, `description`, `price_cents`, `cost_cents`, `shipping_cents`, `region`, `method`, `invoice_number`, `status`, `buyer_id`, `stock_item_id` |
| `social_accounts` | Follower tracking | `name`, `platform`, `status`, `goal`, `log` |

## Conversations and memory (phases 2 and 3)

| Table | Purpose | Key fields |
|---|---|---|
| `conversations` | One conversation, native or imported | `source` (`helios`, `claude_import`), `channel` (`voice`, `text`), `title`, `started_at`, `external_id`, `summary` |
| `messages` | The transcript, never rewritten | `conversation_id`, `seq`, `role`, `text`, `model`, `tokens_in`, `tokens_out` |
| `documents` | Indexed notes, files, PDFs, web pages | `kind`, `path`, `title`, `sha256`, `bytes`, `indexed_at`, `root_id` |
| `file_roots` | Folders HELIOS may read or write | `path`, `access`, `default_sensitivity`, `approved_at` |
| `chunks` | Searchable pieces of messages and documents | `owner_kind`, `owner_id`, `seq`, `text` |
| `chunks_fts` | Full-text index over `chunks` | |
| `chunk_vectors` | Embeddings for `chunks` | `embedding`, `model` (so they can be rebuilt with a better model) |
| `memory_items` | Derived knowledge | `kind` (`fact`, `preference`, `interpretation`, `routine`, `decision`, `action_item`, `open_question`, `summary`), `text`, `status` (`proposed`, `confirmed`, `rejected`, `retired`), `confidence`, `source_kind`, `source_id`, `superseded_by`, `edited_by_owner` |
| `entities` | People, projects, themes, places, tools | `kind`, `name`, `aliases`, `description` |
| `relations` | Links between entities, memories and sources | `from_kind`, `from_id`, `to_kind`, `to_id`, `type`, `weight` |
| `projects` | Projects HELIOS knows about | `name`, `area`, `status`, `repo_path`, `description` |

Two rules are built into this shape:

- **Raw and derived are separate.** `messages` and `documents` are what
  happened. `memory_items` is what HELIOS concluded. A conclusion always
  points at its source and can be rejected without touching the source.
- **Interpretations are a kind, not a truth.** A row with
  `kind = 'interpretation'` is shown and used as "this seems to be the
  case", and the owner can edit or reject it.

## Action and automation (phase 5)

| Table | Purpose | Key fields |
|---|---|---|
| `tools` | Registry of what HELIOS can do | `name`, `source` (`builtin`, `mcp`, `plugin`), `tier`, `schema`, `enabled` |
| `integrations` | Connected services and MCP servers | `kind`, `name`, `config`, `status`, `scopes` |
| `grants` | Standing permissions | `subject_kind`, `subject_id`, `tools`, `scope`, `max_tier`, `expires_at`, `revoked_at` |
| `approvals` | Each time the owner was asked | `action`, `tier`, `status`, `decided_via`, `decided_at`, `session_id` |
| `egress_log` | Each cloud call | `at`, `provider`, `model`, `purpose`, `max_sensitivity`, `bytes`, `approval_id` |
| `workflows` | Saved, schedulable jobs | `name`, `definition`, `schedule`, `enabled`, `grant_id` |
| `agent_runs` | One run of an agent or workflow | `kind`, `goal`, `status`, `started_at`, `ended_at`, `cost`, `scope`, `result_summary` |
| `run_steps` | What a run did, step by step | `run_id`, `seq`, `kind`, `name`, `input`, `output`, `status` |
| `outputs` | Things HELIOS produced | `kind`, `title`, `path`, `sha256`, `saved`, `run_id` |
| `notifications` | What HELIOS wanted to tell the owner | `kind`, `title`, `body`, `priority`, `status` |

## The brain and updates (phases 4 and 6)

| Table | Purpose | Key fields |
|---|---|---|
| `brain_state` | The seed and growth numbers the brain is drawn from | `seed`, `growth` |
| `brain_snapshots` | The monthly image | `month`, `path`, `stats` |
| `updates` | App updates applied | `from_version`, `to_version`, `status`, `snapshot_id` |
