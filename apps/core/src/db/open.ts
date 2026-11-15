import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Opens the database with the settings this app relies on.
 *
 * - WAL journal + synchronous FULL: a change that was confirmed is on disk,
 *   even if the power goes out the moment after.
 * - foreign_keys ON: SQLite does not enforce links between tables unless
 *   asked to, on every connection.
 */
export function openDatabase(file: string, options: { readOnly?: boolean } = {}): Db {
  const db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
  if (!options.readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Runs `work` as one transaction: either every change in it is saved, or
 * none is. Calls inside an open transaction join it.
 */
export function transaction<T>(db: Db, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Throws when the database file is damaged or a link between tables is broken. */
export function checkIntegrity(db: Db): void {
  const result = db.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
  if (result?.quick_check !== "ok") throw new Error(`The database failed its integrity check: ${result?.quick_check}`);
  const broken = db.prepare("PRAGMA foreign_key_check").all();
  if (broken.length > 0) throw new Error(`The database has ${broken.length} broken link(s) between tables.`);
}
