import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../db/open.ts";
import { type DataPaths, isInside, SNAPSHOT_DIRS } from "../paths.ts";
import { createSnapshot, type SnapshotContext, verifySnapshot } from "./snapshot.ts";
import { BackupError, type BackupStore, type Manifest } from "./store.ts";

/**
 * Replaces the data folder's content with a snapshot.
 *
 * The order is what makes this safe:
 *   1. Check every file of the snapshot. Nothing has been touched yet.
 *   2. Snapshot the current state, so the restore itself can be undone.
 *   3. Build the restored data in a staging folder next to the live data.
 *   4. Check the restored database opens and is intact.
 *   5. Swap: move the live folders aside (they are kept, not deleted),
 *      move the staged ones into place.
 *
 * The core must not be running. `current` is the open instance to snapshot
 * first, or null when restoring onto a machine that has no data yet; its
 * database is closed here before the swap.
 */
export async function restoreSnapshot(options: {
  paths: DataPaths;
  store: BackupStore;
  snapshotId: string;
  current: SnapshotContext | null;
}): Promise<{ manifest: Manifest; preRestoreSnapshot: string | null; replacedDir: string | null }> {
  const { paths, store, snapshotId, current } = options;

  // 1. Verify before touching anything.
  const manifest = store.readManifest(snapshotId);
  const verdict = await verifySnapshot(store, snapshotId);
  if (!verdict.ok) {
    const problems = [...verdict.missing.map((p) => `missing: ${p}`), ...verdict.damaged.map((p) => `damaged: ${p}`)];
    throw new BackupError(`Snapshot ${snapshotId} is not complete, so nothing was changed. ${problems.slice(0, 5).join("; ")}`);
  }
  for (const file of manifest.files) {
    // A manifest is outside input. A path like "../../x" must never be written.
    if (path.isAbsolute(file.path) || !isInside(path.join(paths.root, file.path), paths.root)) {
      throw new BackupError(`Snapshot ${snapshotId} names a path outside the data folder (${file.path}). Nothing was changed.`);
    }
  }

  // 2. Make the restore undoable.
  let preRestoreSnapshot: string | null = null;
  if (current) {
    preRestoreSnapshot = (await createSnapshot(current, { kind: "pre_restore", note: `before restoring ${snapshotId}` })).manifest.id;
    current.db.close();
  }

  // 3. Stage.
  const staging = path.join(paths.root, `.restore-${Date.now()}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    await store.extract(manifest.db.sha256, path.join(staging, "db", "homebase.sqlite"));
    for (const file of manifest.files) await store.extract(file.sha256, path.join(staging, file.path));

    // 4. Check the staged database.
    const staged = openDatabase(path.join(staging, "db", "homebase.sqlite"), { readOnly: true });
    try {
      const check = staged.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      if (check?.integrity_check !== "ok") throw new BackupError("The restored database failed its integrity check. Nothing was changed.");
    } finally {
      staged.close();
    }

    // 5. Swap.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const replacedDir = path.join(paths.replaced, stamp);
    let movedAside = false;
    for (const name of ["db", ...SNAPSHOT_DIRS]) {
      const live = path.join(paths.root, name);
      if (existsSync(live)) {
        mkdirSync(replacedDir, { recursive: true });
        renameSync(live, path.join(replacedDir, name));
        movedAside = true;
      }
      const restored = path.join(staging, name);
      if (existsSync(restored)) renameSync(restored, live);
      else mkdirSync(live, { recursive: true });
    }
    // The identity follows the data. The config stays this machine's own
    // (port, backup folders) unless this machine has none.
    const stagedInstance = path.join(staging, "instance.json");
    if (existsSync(stagedInstance)) renameSync(stagedInstance, paths.instanceFile);
    const stagedConfig = path.join(staging, "config.json");
    if (existsSync(stagedConfig) && !existsSync(paths.configFile)) renameSync(stagedConfig, paths.configFile);

    return { manifest, preRestoreSnapshot, replacedDir: movedAside ? replacedDir : null };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The instance id recorded in a data folder, if any. */
export function readInstanceId(paths: DataPaths): string | null {
  if (!existsSync(paths.instanceFile)) return null;
  try {
    return (JSON.parse(readFileSync(paths.instanceFile, "utf8")) as { instanceId?: string }).instanceId ?? null;
  } catch {
    return null;
  }
}
