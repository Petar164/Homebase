import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { backup } from "node:sqlite";
import { type Db, openDatabase, tableExists } from "../db/open.ts";
import { type DataPaths, SNAPSHOT_DIRS } from "../paths.ts";
import { nowIso } from "../util.ts";
import { BackupError, BackupStore, type FileEntry, type Manifest, type SnapshotKind } from "./store.ts";

export type SnapshotContext = {
  db: Db;
  paths: DataPaths;
  instanceId: string;
  appVersion: string;
  schemaVersion: number;
};

export type MirrorResult = { path: string; status: "ok" | "unavailable" | "failed"; detail: string };

/** Every file under `dir`, as paths relative to `base` with forward slashes. */
function walk(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return found;
}

function auditHead(db: Db): Manifest["auditHead"] {
  if (!tableExists(db, "audit_log")) return null;
  const row = db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | undefined;
  return row ? { seq: row.seq, hash: row.hash } : null;
}

/**
 * Takes a snapshot of the database and all data files into the local backup
 * store, then copies it to every mirror that is reachable.
 *
 * The database copy uses SQLite's online backup, so it is a consistent
 * picture of one moment even while the core keeps working.
 */
export async function createSnapshot(
  context: SnapshotContext,
  options: { kind: SnapshotKind; note?: string; mirrors?: string[] },
): Promise<{ manifest: Manifest; mirrors: MirrorResult[] }> {
  const { db, paths, instanceId } = context;
  const store = new BackupStore(paths.backups);
  store.init(instanceId);

  const createdAt = nowIso();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${options.kind}-${randomBytes(3).toString("hex")}`;

  // 1. The database.
  const workDir = path.join(paths.backups, "tmp");
  mkdirSync(workDir, { recursive: true });
  const dbCopy = path.join(workDir, `${id}.sqlite`);
  let dbEntry: { sha256: string; bytes: number };
  try {
    await backup(db, dbCopy);
    const copy = openDatabase(dbCopy, { readOnly: true });
    try {
      const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      if (check?.integrity_check !== "ok") throw new BackupError("The database copy failed its integrity check. No snapshot was written.");
    } finally {
      copy.close();
    }
    dbEntry = await store.putFile(dbCopy);
  } finally {
    rmSync(dbCopy, { force: true });
  }

  // 2. The files.
  const files: FileEntry[] = [];
  const relativePaths = SNAPSHOT_DIRS.flatMap((dir) => walk(path.join(paths.root, dir), paths.root));
  for (const name of ["instance.json", "config.json"]) if (existsSync(path.join(paths.root, name))) relativePaths.push(name);
  for (const relative of relativePaths.sort()) {
    const stored = await store.putFile(path.join(paths.root, relative));
    files.push({ path: relative, ...stored });
  }

  // 3. The manifest. Written last: a snapshot exists only once it is complete.
  const manifest = store.writeManifest({
    format: 1,
    id,
    createdAt,
    kind: options.kind,
    note: options.note ?? "",
    instanceId,
    appVersion: context.appVersion,
    schemaVersion: context.schemaVersion,
    auditHead: auditHead(db),
    db: dbEntry,
    files,
  });

  // 4. Mirrors. A missing drive must not fail the snapshot.
  const mirrors: MirrorResult[] = [];
  for (const mirrorPath of options.mirrors ?? []) mirrors.push(await mirrorSnapshot(store, mirrorPath, [manifest.id]));
  return { manifest, mirrors };
}

/**
 * Copies snapshots to a mirror folder (for example on the external drive).
 * With no ids given it copies every snapshot the mirror does not have yet,
 * which is how a drive that was unplugged catches up.
 *
 * A mirror is only written to if it carries this Home Base's marker file.
 * That way a changed drive letter can never make backups land on, or get
 * mixed into, the wrong drive.
 */
export async function mirrorSnapshot(store: BackupStore, mirrorPath: string, ids?: string[]): Promise<MirrorResult> {
  const mirror = new BackupStore(mirrorPath);
  const own = store.marker();
  try {
    const marker = mirror.marker();
    if (!marker) return { path: mirrorPath, status: "unavailable", detail: "not connected, or not set up as a backup folder" };
    if (!own || marker.instanceId !== own.instanceId) {
      return { path: mirrorPath, status: "failed", detail: "holds backups of a different Home Base" };
    }
    const present = new Set(mirror.list().manifests.map((manifest) => manifest.id));
    const wanted = ids ?? store.list().manifests.map((manifest) => manifest.id);
    let copied = 0;
    for (const id of wanted) {
      if (present.has(id)) continue;
      await store.copySnapshotTo(mirror, id);
      copied++;
    }
    return { path: mirrorPath, status: "ok", detail: `${copied} snapshot(s) copied` };
  } catch (error) {
    return { path: mirrorPath, status: "failed", detail: (error as Error).message };
  }
}

/** Sets a folder up as a mirror. Explicit, so backups never start on a drive by accident. */
export function initMirror(mirrorPath: string, instanceId: string): void {
  new BackupStore(mirrorPath).init(instanceId);
}

/** Re-reads every blob of a snapshot and checks it against its hash. */
export async function verifySnapshot(store: BackupStore, id: string): Promise<{ ok: boolean; missing: string[]; damaged: string[] }> {
  const manifest = store.readManifest(id);
  const missing: string[] = [];
  const damaged: string[] = [];
  const entries = [{ path: "db/homebase.sqlite", sha256: manifest.db.sha256 }, ...manifest.files];
  const seen = new Map<string, boolean>();
  for (const entry of entries) {
    if (!store.hasBlob(entry.sha256)) {
      missing.push(entry.path);
      continue;
    }
    let ok = seen.get(entry.sha256);
    if (ok === undefined) {
      ok = await store.verifyBlob(entry.sha256);
      seen.set(entry.sha256, ok);
    }
    if (!ok) damaged.push(entry.path);
  }
  return { ok: missing.length === 0 && damaged.length === 0, missing, damaged };
}
