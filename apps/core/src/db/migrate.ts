import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkIntegrity, type Db, tableExists, transaction } from "./open.ts";

// The schema only ever changes through numbered SQL files ("migrations").
// Each one runs exactly once, inside a transaction, and is recorded with a
// checksum. Nothing here can reset or recreate a database.

export type Migration = { version: number; name: string; sql: string; checksum: string };
type AppliedRow = { version: number; name: string; checksum: string };

export class MigrationError extends Error {}

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Line endings are normalised so a Windows checkout gives the same checksum. */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

export function loadMigrations(dir: string): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match) throw new MigrationError(`Migration file "${file}" must be named like 0003_add_notes.sql.`);
      const sql = readFileSync(path.join(dir, file), "utf8");
      return { version: Number(match[1]), name: match[2] ?? "", sql, checksum: checksumOf(sql) };
    });
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(`Migrations must be numbered 0001, 0002, 0003 without gaps; found ${migration.version}.`);
    }
  });
  return migrations;
}

export function appliedMigrations(db: Db): AppliedRow[] {
  if (!tableExists(db, "schema_migrations")) return [];
  return db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as AppliedRow[];
}

/**
 * Compares the database with the migration files without changing anything.
 * Throws when it would be unsafe to continue.
 */
export function planMigrations(db: Db, migrations: Migration[]): { current: number; latest: number; pending: Migration[] } {
  const applied = appliedMigrations(db);
  const current = applied.at(-1)?.version ?? 0;
  const latest = migrations.length;

  if (current > latest) {
    throw new MigrationError(
      `This data was written by a newer version of Home Base (schema ${current}); ` +
        `this version only knows schema ${latest}. Update the app. Nothing was changed.`,
    );
  }
  applied.forEach((row, index) => {
    const migration = migrations[index];
    if (row.version !== index + 1 || !migration || migration.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) was changed after it was applied to this database. ` +
          "Applied migrations must never be edited; add a new one instead. Nothing was changed.",
      );
    }
  });
  return { current, latest, pending: migrations.slice(current) };
}

/** Applies every pending migration. Returns the versions it applied. */
export function runMigrations(db: Db, migrations: Migration[], appVersion: string): number[] {
  const { pending } = planMigrations(db, migrations);
  if (pending.length === 0) return [];

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    app_version TEXT NOT NULL
  ) STRICT`);

  for (const migration of pending) {
    try {
      // Schema changes are transactional in SQLite: if any statement in the
      // file fails, the whole file is undone and the database is as before.
      transaction(db, () => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)").run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
          appVersion,
        );
      });
    } catch (error) {
      throw new MigrationError(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${(error as Error).message}`,
      );
    }
  }
  db.exec(`PRAGMA user_version = ${migrations.length}`);
  checkIntegrity(db);
  return pending.map((migration) => migration.version);
}
