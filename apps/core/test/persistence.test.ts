import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { restoreSnapshot } from "../src/backup/restore.ts";
import { scheduledSnapshotDue, snapshotsToDelete } from "../src/backup/retention.ts";
import { createSnapshot, initMirror, mirrorSnapshot, verifySnapshot } from "../src/backup/snapshot.ts";
import { BackupStore, type SnapshotKind } from "../src/backup/store.ts";
import { defaultConfig } from "../src/config.ts";
import { appliedMigrations, checksumOf, MigrationError, planMigrations, runMigrations } from "../src/db/migrate.ts";
import { openDatabase, tableExists } from "../src/db/open.ts";
import { openInstance, StartupRefused } from "../src/instance.ts";
import { APP_ROOT, dataPaths } from "../src/paths.ts";
import { insertTask, migration, realMigrations, taskTitles, tempDir, track } from "./helpers.ts";

// These tests are the proof behind docs/PERSISTENCE.md. Each "guarantee"
// there has at least one test here.

function blobCount(store: string): number {
  const blobs = path.join(store, "blobs");
  return readdirSync(blobs).reduce((total, prefix) => total + readdirSync(path.join(blobs, prefix)).length, 0);
}

describe("migrations", () => {
  it("applies every migration once and records it", () => {
    const db = openDatabase(path.join(tempDir(), "a.sqlite"));
    const migrations = realMigrations();
    expect(runMigrations(db, migrations, "test")).toEqual(migrations.map((m) => m.version));
    expect(appliedMigrations(db).map((row) => row.checksum)).toEqual(migrations.map((m) => m.checksum));
    expect(runMigrations(db, migrations, "test")).toEqual([]);
    db.close();
  });

  it("rolls a failing migration back completely", () => {
    const db = openDatabase(path.join(tempDir(), "a.sqlite"));
    const good = migration(1, "good", "CREATE TABLE a (id TEXT) STRICT;");
    const bad = migration(2, "bad", "CREATE TABLE b (id TEXT) STRICT; INSERT INTO nowhere VALUES (1);");
    expect(() => runMigrations(db, [good, bad], "test")).toThrow(MigrationError);
    expect(tableExists(db, "a")).toBe(true); // migration 1 stays
    expect(tableExists(db, "b")).toBe(false); // nothing of migration 2 remains
    expect(appliedMigrations(db).map((row) => row.version)).toEqual([1]);
    db.close();
  });

  it("refuses when an applied migration was edited", () => {
    const db = openDatabase(path.join(tempDir(), "a.sqlite"));
    runMigrations(db, [migration(1, "first", "CREATE TABLE a (id TEXT) STRICT;")], "test");
    expect(() => planMigrations(db, [migration(1, "first", "CREATE TABLE a (id TEXT, extra TEXT) STRICT;")])).toThrow(/changed after it was applied/);
    db.close();
  });

  it("refuses to open data written by a newer version", () => {
    const db = openDatabase(path.join(tempDir(), "a.sqlite"));
    const one = migration(1, "first", "CREATE TABLE a (id TEXT) STRICT;");
    const two = migration(2, "second", "CREATE TABLE b (id TEXT) STRICT;");
    runMigrations(db, [one, two], "test");
    expect(() => planMigrations(db, [one])).toThrow(/newer version/);
    db.close();
  });

  it("gives the same checksum for Windows and Unix line endings", () => {
    expect(checksumOf("CREATE TABLE a (id TEXT);\r\n")).toBe(checksumOf("CREATE TABLE a (id TEXT);\n"));
  });
});

describe("opening a Home Base", () => {
  it("creates the data on first start and finds it again after a restart", async () => {
    const dataDir = tempDir();
    const first = track(await openInstance({ dataDir }));
    expect(first.fresh).toBe(true);
    insertTask(first, "t1", "Survive a restart");
    first.close();

    const second = track(await openInstance({ dataDir }));
    expect(second.fresh).toBe(false);
    expect(second.instanceId).toBe(first.instanceId);
    expect(taskTitles(second)).toEqual(["Survive a restart"]);
  });

  it("refuses a data folder inside the app folder", async () => {
    await expect(openInstance({ dataDir: path.join(APP_ROOT, "private", "would-be-data") })).rejects.toThrow(/inside the app folder/);
  });

  it("keeps existing rows through an update and snapshots first", async () => {
    const dataDir = tempDir();
    const before = track(await openInstance({ dataDir }));
    insertTask(before, "t1", "Written by the old version");
    const oldSchema = before.schemaVersion;
    before.close();

    // The "update": the same app with one more migration.
    const updated = [...realMigrations(), migration(oldSchema + 1, "add_estimate", "ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER;")];
    const after = track(await openInstance({ dataDir, migrations: updated }));
    expect(after.migrated).toEqual([oldSchema + 1]);
    expect(taskTitles(after)).toEqual(["Written by the old version"]);

    // The snapshot holds the database as it was before the change.
    expect(after.preMigrationSnapshot).not.toBeNull();
    const manifest = new BackupStore(after.paths.backups).readManifest(after.preMigrationSnapshot as string);
    expect(manifest.kind).toBe("pre_migration");
    expect(manifest.schemaVersion).toBe(oldSchema);
  });

  it("leaves the data untouched when an update's migration fails", async () => {
    const dataDir = tempDir();
    const before = track(await openInstance({ dataDir }));
    insertTask(before, "t1", "Must not be lost");
    const oldSchema = before.schemaVersion;
    before.close();

    const broken = [...realMigrations(), migration(oldSchema + 1, "broken", "ALTER TABLE tasks ADD COLUMN x TEXT; DROP TABLE does_not_exist;")];
    await expect(openInstance({ dataDir, migrations: broken })).rejects.toThrow(StartupRefused);

    // The old version still opens it, at the old schema, with the row.
    const again = track(await openInstance({ dataDir }));
    expect(again.migrated).toEqual([]);
    expect(taskTitles(again)).toEqual(["Must not be lost"]);
  });

  it("refuses to start blank when the database is missing from a used folder", async () => {
    const dataDir = tempDir();
    const instance = track(await openInstance({ dataDir }));
    insertTask(instance, "t1", "Real data");
    instance.close();
    rmSync(instance.paths.dbDir, { recursive: true });

    await expect(openInstance({ dataDir })).rejects.toThrow(/NOT created/);
    expect(existsSync(instance.paths.dbFile)).toBe(false);
  });

  it("refuses when older code meets a newer database", async () => {
    const dataDir = tempDir();
    const newer = [...realMigrations(), migration(realMigrations().length + 1, "future", "CREATE TABLE future (id TEXT) STRICT;")];
    track(await openInstance({ dataDir, migrations: newer })).close();
    await expect(openInstance({ dataDir })).rejects.toThrow(/newer version/);
  });
});

describe("snapshots", () => {
  it("restores the database and files exactly, and keeps what it replaced", async () => {
    const dataDir = tempDir();
    const instance = track(await openInstance({ dataDir }));
    insertTask(instance, "t1", "Original task");
    mkdirSync(path.join(instance.paths.vault, "ideas"), { recursive: true });
    writeFileSync(path.join(instance.paths.vault, "ideas", "helios.md"), "# The original note\n");
    const { manifest } = await createSnapshot(instance, { kind: "manual" });

    // Damage: change the row, delete the note, add another.
    instance.db.prepare("UPDATE tasks SET title = 'Overwritten by mistake' WHERE id = 't1'").run();
    rmSync(path.join(instance.paths.vault, "ideas", "helios.md"));
    writeFileSync(path.join(instance.paths.vault, "later.md"), "added after the snapshot\n");

    const store = new BackupStore(instance.paths.backups);
    const result = await restoreSnapshot({ paths: instance.paths, store, snapshotId: manifest.id, current: instance });
    instance.close();

    const restored = track(await openInstance({ dataDir }));
    expect(taskTitles(restored)).toEqual(["Original task"]);
    expect(readFileSync(path.join(restored.paths.vault, "ideas", "helios.md"), "utf8")).toBe("# The original note\n");
    expect(existsSync(path.join(restored.paths.vault, "later.md"))).toBe(false);

    // The state from just before the restore is itself a snapshot, and the
    // replaced folders were moved aside, not deleted.
    expect(store.readManifest(result.preRestoreSnapshot as string).kind).toBe("pre_restore");
    expect(existsSync(path.join(result.replacedDir as string, "vault", "later.md"))).toBe(true);
  });

  it("stores unchanged files only once", async () => {
    const instance = track(await openInstance({ dataDir: tempDir() }));
    writeFileSync(path.join(instance.paths.vault, "note.md"), "same content every time\n");
    await createSnapshot(instance, { kind: "manual" });
    const afterFirst = blobCount(instance.paths.backups);
    await createSnapshot(instance, { kind: "manual" });
    // Nothing changed, not even the database: no new content was stored.
    expect(blobCount(instance.paths.backups)).toBe(afterFirst);
  });

  it("detects a damaged backup and refuses to restore from it", async () => {
    const instance = track(await openInstance({ dataDir: tempDir() }));
    insertTask(instance, "t1", "Live data");
    writeFileSync(path.join(instance.paths.vault, "note.md"), "important\n");
    const { manifest } = await createSnapshot(instance, { kind: "manual" });
    const store = new BackupStore(instance.paths.backups);
    expect((await verifySnapshot(store, manifest.id)).ok).toBe(true);

    const note = manifest.files.find((file) => file.path === "vault/note.md");
    writeFileSync(store.blobPath(note?.sha256 as string), "not the real content");
    expect((await verifySnapshot(store, manifest.id)).damaged).toEqual(["vault/note.md"]);

    await expect(restoreSnapshot({ paths: instance.paths, store, snapshotId: manifest.id, current: instance })).rejects.toThrow(/nothing was changed/);
    expect(taskTitles(instance)).toEqual(["Live data"]); // still open, still intact
  });

  it("rebuilds a lost machine from the mirror on another drive", async () => {
    const dataDir = tempDir();
    const drive = path.join(tempDir(), "HomeBaseBackups");
    const instance = track(await openInstance({ dataDir }));
    insertTask(instance, "t1", "Only copy is on the external drive");
    writeFileSync(path.join(instance.paths.vault, "note.md"), "kept\n");

    initMirror(drive, instance.instanceId);
    const { manifest, mirrors } = await createSnapshot(instance, { kind: "scheduled", mirrors: [drive] });
    expect(mirrors[0]?.status).toBe("ok");
    instance.close();
    rmSync(dataDir, { recursive: true }); // the laptop is gone

    const newMachine = tempDir();
    await restoreSnapshot({ paths: dataPaths(newMachine), store: new BackupStore(drive), snapshotId: manifest.id, current: null });
    const rebuilt = track(await openInstance({ dataDir: newMachine }));
    expect(rebuilt.instanceId).toBe(instance.instanceId);
    expect(taskTitles(rebuilt)).toEqual(["Only copy is on the external drive"]);
    expect(readFileSync(path.join(rebuilt.paths.vault, "note.md"), "utf8")).toBe("kept\n");
  });

  it("never writes to a folder that is not set up as a mirror, and catches up later", async () => {
    const instance = track(await openInstance({ dataDir: tempDir() }));
    const drive = path.join(tempDir(), "HomeBaseBackups");

    // Drive "unplugged": the snapshot succeeds, the mirror is skipped.
    const { mirrors } = await createSnapshot(instance, { kind: "scheduled", mirrors: [drive] });
    expect(mirrors[0]?.status).toBe("unavailable");
    expect(existsSync(drive)).toBe(false);

    // Drive connected and set up: one call copies everything it missed.
    initMirror(drive, instance.instanceId);
    await createSnapshot(instance, { kind: "manual" });
    const store = new BackupStore(instance.paths.backups);
    expect((await mirrorSnapshot(store, drive)).status).toBe("ok");
    expect(new BackupStore(drive).list().manifests).toHaveLength(2);

    // A drive holding someone else's backups is refused.
    const foreign = path.join(tempDir(), "Other");
    initMirror(foreign, "another-home-base");
    expect((await mirrorSnapshot(store, foreign)).status).toBe("failed");
  });
});

describe("retention", () => {
  const policy = defaultConfig().backup.retention;
  const now = new Date("2026-12-31T12:00:00.000Z");
  const daysAgo = (days: number, kind: SnapshotKind = "scheduled") => {
    const createdAt = new Date(now.getTime() - days * 86_400_000).toISOString();
    return { id: `${kind}-${days}`, createdAt, kind };
  };

  it("thins snapshots out with age and always keeps the newest", () => {
    const daily = Array.from({ length: 400 }, (_, day) => daysAgo(day));
    const removed = new Set(snapshotsToDelete(daily, now, policy));
    const kept = daily.filter((snapshot) => !removed.has(snapshot.id));

    for (let day = 0; day <= 7; day++) expect(removed.has(`scheduled-${day}`)).toBe(false);
    // Between a week and two months old: one per week, plus the two month-ends.
    const weekly = kept.filter((s) => { const age = Number(s.id.split("-")[1]); return age > 7 && age <= 63; });
    expect(weekly.length).toBeGreaterThanOrEqual(7);
    expect(weekly.length).toBeLessThanOrEqual(11);
    // Older than that: one per month.
    const monthly = kept.filter((s) => Number(s.id.split("-")[1]) > 63);
    expect(monthly.length).toBeGreaterThanOrEqual(10);
    expect(monthly.length).toBeLessThanOrEqual(12);
    // Far fewer are kept than were taken, and the newest is among them.
    expect(kept.length).toBeLessThan(40);
    expect(removed.has("scheduled-0")).toBe(false);
  });

  it("keeps safety snapshots for their window, then lets them go", () => {
    const removed = snapshotsToDelete([daysAgo(0), daysAgo(10, "pre_migration"), daysAgo(45, "pre_restore")], now, policy);
    expect(removed).toEqual(["pre_restore-45"]);
  });

  it("keeps a lone old snapshot rather than leaving none", () => {
    expect(snapshotsToDelete([daysAgo(3000)], now, policy)).toEqual([]);
  });

  it("knows when the next scheduled snapshot is due", () => {
    expect(scheduledSnapshotDue([], now, 24)).toBe(true);
    expect(scheduledSnapshotDue([daysAgo(0.5)], now, 24)).toBe(false);
    expect(scheduledSnapshotDue([daysAgo(2)], now, 24)).toBe(true);
    expect(scheduledSnapshotDue([daysAgo(0.1, "pre_migration"), daysAgo(2)], now, 24)).toBe(true);
  });
});
