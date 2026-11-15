import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { checksumOf, loadMigrations, type Migration } from "../src/db/migrate.ts";
import type { Instance } from "../src/instance.ts";
import { MIGRATIONS_DIR } from "../src/paths.ts";

const created: string[] = [];
const opened: Instance[] = [];

/** A fresh temporary folder, removed after the test. */
export function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "homebase-test-"));
  created.push(dir);
  return dir;
}

/** Registers an instance so it is closed after the test even if the test fails. */
export function track(instance: Instance): Instance {
  opened.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of opened.splice(0)) instance.close();
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const realMigrations = (): Migration[] => loadMigrations(MIGRATIONS_DIR);

/** Builds a migration the way a file on disk would be loaded. */
export function migration(version: number, name: string, sql: string): Migration {
  return { version, name, sql, checksum: checksumOf(sql) };
}

export function insertTask(instance: Instance, id: string, title: string): void {
  const now = new Date().toISOString();
  instance.db.prepare("INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, title, now, now);
}

export function taskTitles(instance: Instance): string[] {
  return (instance.db.prepare("SELECT title FROM tasks ORDER BY id").all() as { title: string }[]).map((row) => row.title);
}
