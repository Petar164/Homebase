import type { SnapshotSummary, SystemStatus } from "@homebase/shared";
import { scheduledSnapshotDue, snapshotsToDelete } from "../backup/retention.ts";
import { createSnapshot, mirrorSnapshot } from "../backup/snapshot.ts";
import { BackupStore, type Manifest } from "../backup/store.ts";
import type { Instance } from "../instance.ts";
import { audit, verifyAuditLog } from "../security/audit.ts";
import type { Logger } from "../util.ts";

export function summarise(manifest: Manifest): SnapshotSummary {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    kind: manifest.kind,
    note: manifest.note,
    schemaVersion: manifest.schemaVersion,
    files: manifest.files.length,
    bytes: manifest.db.bytes + manifest.files.reduce((total, file) => total + file.bytes, 0),
  };
}

let running = false;

/**
 * One pass of backup housekeeping. Safe to call often; it only does work
 * when work is due:
 *   1. take the scheduled snapshot if the interval has passed
 *   2. bring every reachable mirror up to date (a drive that was unplugged
 *      catches up here)
 *   3. remove snapshots the retention schedule no longer keeps, then the
 *      stored content nothing refers to any more
 */
export async function runBackupCycle(instance: Instance, log: Logger, now: Date = new Date()): Promise<{ created: string | null; removed: number }> {
  if (running) return { created: null, removed: 0 };
  running = true;
  try {
    const store = new BackupStore(instance.paths.backups);
    const { backup } = instance.config;
    let created: string | null = null;

    if (scheduledSnapshotDue(store.list().manifests, now, backup.intervalHours)) {
      const { manifest } = await createSnapshot(instance, { kind: "scheduled" });
      created = manifest.id;
      audit(instance.db, { actor: "system", action: "backup.create", target: manifest.id, detail: { kind: "scheduled" } });
      log.info(`Snapshot ${manifest.id} taken.`);
    }

    for (const mirrorPath of backup.mirrors) {
      const result = await mirrorSnapshot(store, mirrorPath);
      if (result.status === "failed") log.warn(`Backup mirror ${mirrorPath}: ${result.detail}`);
    }

    const { manifests } = store.list();
    const stale = snapshotsToDelete(manifests, now, backup.retention);
    for (const id of stale) store.deleteManifest(id);
    if (stale.length > 0) {
      store.collectGarbage();
      audit(instance.db, { actor: "system", action: "backup.prune", detail: { removed: stale.length } });
    }
    return { created, removed: stale.length };
  } finally {
    running = false;
  }
}

/** What the status screen shows about the health of this Home Base. */
export function systemStatus(instance: Instance, startedAt: string): SystemStatus {
  const { manifests } = new BackupStore(instance.paths.backups).list();
  const newest = manifests.at(-1) ?? null;
  const mirrors = instance.config.backup.mirrors.map((mirrorPath) => {
    const mirror = new BackupStore(mirrorPath);
    let connected = false;
    let newestAt: string | null = null;
    try {
      connected = mirror.marker()?.instanceId === instance.instanceId;
      if (connected) newestAt = mirror.list().manifests.at(-1)?.createdAt ?? null;
    } catch {
      connected = false;
    }
    return { path: mirrorPath, connected, newestAt };
  });
  const verdict = verifyAuditLog(instance.db);
  return {
    version: instance.appVersion,
    schemaVersion: instance.schemaVersion,
    startedAt,
    snapshots: { count: manifests.length, newestAt: newest?.createdAt ?? null, newestKind: newest?.kind ?? null },
    mirrors,
    audit: { ok: verdict.ok, entries: verdict.entries },
  };
}
