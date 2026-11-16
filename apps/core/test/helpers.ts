import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, aroundAll, beforeAll, TestRunner } from "vitest";
import { checksumOf, loadMigrations, type Migration } from "../src/db/migrate.ts";
import type { Instance } from "../src/instance.ts";
import { MIGRATIONS_DIR } from "../src/paths.ts";

// Cleaning up always means: close what is open, then remove its folder.
// Windows refuses to delete a file that is still open. A Mac deletes it
// without a word, so a mistake in the order shows up only on Windows.

const newDir = (): string => mkdtempSync(path.join(os.tmpdir(), "homebase-test-"));
const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true });

const created: string[] = [];
const opened: Instance[] = [];

/** `tempDir` and `track` clean up after the running test, so there has to be one. */
function needsRunningTest(name: string): void {
  if (TestRunner.getCurrentTest()) return;
  throw new Error(
    `${name}() was called outside a test, for example in beforeAll. It cleans up after every single test, ` +
      "so it cannot hold what a group of tests shares. Use sharedAcrossTests() for that.",
  );
}

/** A fresh temporary folder, removed after the test. */
export function tempDir(): string {
  needsRunningTest("tempDir");
  const dir = newDir();
  created.push(dir);
  return dir;
}

/** Registers an instance so it is closed after the test even if the test fails. */
export function track(instance: Instance): Instance {
  needsRunningTest("track");
  opened.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of opened.splice(0)) instance.close();
  for (const dir of created.splice(0)) removeDir(dir);
});

type Closable = { close(): unknown };

/** `tempDir` and `track` again, for what a group of tests shares. */
export type Shared = {
  /** A fresh temporary folder, removed when the group is over. */
  tempDir(): string;
  /** Registers something to close when the group is over, before its folders are removed. */
  track<T extends Closable>(thing: T): T;
};

// A hook counts only if it is registered while the tests are being defined.
let definingTests = true;
beforeAll(() => {
  definingTests = false;
});

/**
 * For what a group of tests shares, such as one server opened in `beforeAll`.
 * Call it where the group is defined: at the top of the file, or inside
 * `describe`.
 *
 * Its cleanup is the last thing to happen in the group: after the last test,
 * after the group's `afterAll` hooks and after whatever its `beforeAll` hooks
 * return. Everything tracked is closed, newest first, and only then are the
 * folders removed.
 */
export function sharedAcrossTests(): Shared {
  if (!definingTests) {
    throw new Error(
      "sharedAcrossTests() was called from a test or a hook. Call it where the tests are defined " +
        "(the top of the file, or inside describe): set up any later, its cleanup would never run.",
    );
  }
  const dirs: string[] = [];
  const tracked: Closable[] = [];
  // Wrapped around the whole group, so it also runs when a `beforeAll` fails.
  aroundAll(async (runGroup) => {
    try {
      await runGroup();
    } finally {
      for (const thing of tracked.splice(0).reverse()) await thing.close();
      for (const dir of dirs.splice(0)) removeDir(dir);
    }
  });
  return {
    tempDir() {
      const dir = newDir();
      dirs.push(dir);
      return dir;
    },
    track(thing) {
      tracked.push(thing);
      return thing;
    },
  };
}

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
