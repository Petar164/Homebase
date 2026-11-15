# Persistence: how nothing gets lost

An earlier app of mine lost all saved data on every update. This system is
built so that cannot happen. This document is the contract.

## The guarantees

1. **Updating or reinstalling the app never touches data.** Data lives in a
   separate data folder that no install, update or `git` command writes to.
2. **A blank database is never created over an existing one.** If the data
   folder shows signs of earlier use and the database is missing or damaged,
   the core refuses to start and offers a restore.
3. **Every schema change takes a snapshot first** and runs in a transaction.
   It either completes or leaves the database exactly as it was.
4. **Older code never opens newer data.** If the database was written by a
   newer version, the core stops instead of guessing.
5. **Every snapshot can be verified and restored**, on this machine or a new
   one, and a restore first takes a snapshot of what it is about to replace.

Each guarantee has an automated test in `apps/core/test`.

## Where data lives

| System | Default data folder |
|---|---|
| Windows | `%LOCALAPPDATA%\HomeBase` |
| macOS | `~/Library/Application Support/HomeBase` |
| Linux | `~/.local/share/homebase` |

Set `HOMEBASE_DATA_DIR` to use another location.

```
<data folder>/
  instance.json     identity of this Home Base (id, creation date)
  config.json       settings needed before the database opens (port, backup targets)
  db/homebase.sqlite
  vault/            the knowledge base, as plain Markdown files
  files/            imported documents and archives
  outputs/          things HELIOS made and you chose to keep
  snapshots/brain/  the monthly image of the brain
  backups/          the local backup store
  logs/
```

Markdown, SQLite and plain files were chosen because they can be opened
without this app, in ten years, by other tools.

## Migrations

A migration is a numbered SQL file in `apps/core/migrations`, for example
`0002_home_base.sql`. Rules:

- Files are applied in order, once, and recorded in `schema_migrations` with
  a checksum.
- A file that has been applied must never change. If its checksum differs,
  the core refuses to start.
- Before the first pending migration, a `pre_migration` snapshot is taken.
- Each migration runs in one transaction. A failure rolls back fully.
- After migrating, foreign keys and database integrity are checked.
- There are no "down" migrations. Going back means restoring the snapshot.

## Backups

A snapshot captures the database (using SQLite's online backup, so it is
consistent even while the core is running) and every file in `vault`,
`files`, `outputs` and `snapshots`.

The backup store is content-addressed: each file is stored once under the
hash of its content, and a snapshot is a small manifest listing paths and
hashes. Consequences:

- A file that did not change costs nothing in the next snapshot.
- Verifying a snapshot means re-hashing its files. Corruption cannot hide.
- Copying to another drive is copying the missing files, and can resume.

| When | Kind |
|---|---|
| Every day, and at least every week even if the machine was off | `scheduled` |
| Before a schema migration | `pre_migration` |
| Before an app update | `pre_update` |
| Before a restore | `pre_restore` |
| On request | `manual` |

Snapshots are kept on a thinning schedule: all from the last 7 days, one per
week for 8 weeks, one per month for 24 months. Safety snapshots (the three
`pre_` kinds) are kept for at least 30 days.

### Three places

1. **Local store** in the data folder. Protects against bad updates and
   mistakes. Does not protect against a dead disk.
2. **External drive.** Every snapshot is mirrored to the 5 TB drive when it
   is connected. The drive is recognised by a marker file, not by its drive
   letter, because Windows can change the letter. If the drive is missing,
   the snapshot still succeeds and the mirror catches up later.
3. **Off the machine** (planned, phase 2). Encrypted copies to a cloud
   folder, so a stolen or burned laptop is not the end. The encryption key
   is a recovery phrase that is written down and kept elsewhere.

## Restore

```bash
homebase backups list
homebase backups verify <snapshot>
homebase restore <snapshot>
```

A restore checks every file of the snapshot before it changes anything,
takes a `pre_restore` snapshot of the current state, builds the restored
data next to the live data, then swaps them. The replaced data is kept in a
dated folder until it is cleaned up by hand. Restoring onto a new machine is
the same command with `--from <backup folder>`.

For a single wrong edit, a full restore is too blunt. Records that matter
(tasks, sales, ledger entries, memories) keep their previous versions in
`record_revisions`, and deleting marks a row as deleted instead of removing
it.

## Updates

An update is new code plus, sometimes, new migrations.

1. The core notices a newer version and tells you. Nothing is installed
   without permission.
2. On approval: `pre_update` snapshot, fetch the new code, install
   dependencies, run migrations, restart, health check.
3. If the health check fails: switch back to the previous code and restore
   the `pre_update` snapshot.

Until the in-app flow exists (phase 6), updating is `git pull`, `npm ci` and
a restart, and the migration and snapshot rules above already apply.

## What can still go wrong

- A snapshot protects only what existed when it was taken. With daily
  snapshots, up to a day of changes can be lost in a disk failure.
- If the external drive is never connected, there is one copy of everything.
  The status screen shows the age of the newest mirror for that reason.
- Until off-machine backup exists, theft or fire of both laptop and drive
  loses everything.
