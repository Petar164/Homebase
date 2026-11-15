import { createHash, type Hash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { nowIso, writeFileAtomic } from "../util.ts";

// A backup store is a folder with two things in it:
//
//   blobs/      every file ever backed up, compressed, named by the SHA-256
//               hash of its content. The same content is stored once.
//   snapshots/  one small JSON "manifest" per snapshot: which paths existed
//               and the hash of each one's content.
//
// Because a blob's name is the hash of its content, a damaged file cannot
// go unnoticed (its content no longer matches its name), an unchanged file
// costs nothing in the next snapshot, and copying a snapshot to another
// drive is just copying the blobs that drive does not have yet.

export const SNAPSHOT_KINDS = ["scheduled", "manual", "pre_migration", "pre_update", "pre_restore"] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

export type FileEntry = { path: string; sha256: string; bytes: number };

export type Manifest = {
  format: 1;
  id: string;
  createdAt: string;
  kind: SnapshotKind;
  note: string;
  instanceId: string;
  appVersion: string;
  schemaVersion: number;
  /** The newest audit-log entry at snapshot time. Anchors the audit chain outside the database. */
  auditHead: { seq: number; hash: string } | null;
  db: { sha256: string; bytes: number };
  files: FileEntry[];
  /** SHA-256 over all fields above, so a damaged manifest is detected. */
  checksum: string;
};

type Marker = { format: 1; instanceId: string; createdAt: string };

export class BackupError extends Error {}

function manifestChecksum(body: Omit<Manifest, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Passes data through unchanged while feeding it to a hash and counting bytes. */
function tap(hash: Hash, counter: { bytes: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      counter.bytes += chunk.length;
      done(null, chunk);
    },
  });
}

async function flushToDisk(file: string): Promise<void> {
  const handle = await open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class BackupStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private get markerFile() {
    return path.join(this.root, "homebase-backups.json");
  }
  private get blobsDir() {
    return path.join(this.root, "blobs");
  }
  private get snapshotsDir() {
    return path.join(this.root, "snapshots");
  }
  private get tmpDir() {
    return path.join(this.root, "tmp");
  }

  /** The marker file identifies a folder as a backup store, and whose it is. */
  marker(): Marker | null {
    if (!existsSync(this.markerFile)) return null;
    try {
      return JSON.parse(readFileSync(this.markerFile, "utf8")) as Marker;
    } catch {
      throw new BackupError(`${this.markerFile} is unreadable. This backup folder needs attention.`);
    }
  }

  /** Creates the store if needed. Refuses a store that belongs to a different Home Base. */
  init(instanceId: string): void {
    const marker = this.marker();
    if (marker && marker.instanceId !== instanceId) {
      throw new BackupError(`${this.root} holds backups of a different Home Base (${marker.instanceId}). Use another folder.`);
    }
    for (const dir of [this.blobsDir, this.snapshotsDir, this.tmpDir]) mkdirSync(dir, { recursive: true });
    if (!marker) writeFileAtomic(this.markerFile, `${JSON.stringify({ format: 1, instanceId, createdAt: nowIso() }, null, 2)}\n`);
  }

  private tmpFile(): string {
    mkdirSync(this.tmpDir, { recursive: true });
    return path.join(this.tmpDir, `${Date.now()}-${randomBytes(6).toString("hex")}.tmp`);
  }

  blobPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new BackupError(`"${sha256}" is not a content hash.`);
    return path.join(this.blobsDir, sha256.slice(0, 2), `${sha256}.gz`);
  }

  hasBlob(sha256: string): boolean {
    return existsSync(this.blobPath(sha256));
  }

  /** Stores a file's content and returns its hash. Content already in the store is not written again. */
  async putFile(file: string): Promise<{ sha256: string; bytes: number }> {
    // First pass: hash only. Most files did not change since the last snapshot.
    const firstHash = createHash("sha256");
    const firstCount = { bytes: 0 };
    await pipeline(createReadStream(file), tap(firstHash, firstCount), async (source) => {
      for await (const _chunk of source) void _chunk;
    });
    const first = firstHash.digest("hex");
    if (this.hasBlob(first)) return { sha256: first, bytes: firstCount.bytes };

    // Second pass: compress into the store. The hash is computed again from
    // exactly the bytes that were written, so the blob always matches its
    // name even if the file changed between the two passes.
    const hash = createHash("sha256");
    const count = { bytes: 0 };
    const temporary = this.tmpFile();
    await pipeline(createReadStream(file), tap(hash, count), createGzip(), createWriteStream(temporary));
    await flushToDisk(temporary);
    const sha256 = hash.digest("hex");
    this.adoptBlob(temporary, sha256);
    return { sha256, bytes: count.bytes };
  }

  private adoptBlob(temporary: string, sha256: string): void {
    const target = this.blobPath(sha256);
    if (existsSync(target)) {
      rmSync(temporary);
      return;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(temporary, target);
  }

  /** Decompresses a blob while checking that its content still matches its name. */
  private async readBlobInto(sha256: string, destination: string | null): Promise<void> {
    const source = this.blobPath(sha256);
    if (!existsSync(source)) throw new BackupError(`Backup content ${sha256.slice(0, 12)} is missing from ${this.root}.`);
    const hash = createHash("sha256");
    const count = { bytes: 0 };
    try {
      if (destination) {
        await pipeline(createReadStream(source), createGunzip(), tap(hash, count), createWriteStream(destination));
      } else {
        await pipeline(createReadStream(source), createGunzip(), tap(hash, count), async (stream) => {
          for await (const _chunk of stream) void _chunk;
        });
      }
    } catch {
      throw new BackupError(`Backup content ${sha256.slice(0, 12)} in ${this.root} is damaged.`);
    }
    if (hash.digest("hex") !== sha256) throw new BackupError(`Backup content ${sha256.slice(0, 12)} in ${this.root} is damaged.`);
  }

  async verifyBlob(sha256: string): Promise<boolean> {
    try {
      await this.readBlobInto(sha256, null);
      return true;
    } catch {
      return false;
    }
  }

  /** Writes a blob's content to `destination`, verified, replacing it in one step. */
  async extract(sha256: string, destination: string): Promise<void> {
    mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await this.readBlobInto(sha256, temporary);
      await flushToDisk(temporary);
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private manifestFile(id: string): string {
    if (!/^[\w.-]+$/.test(id)) throw new BackupError(`"${id}" is not a snapshot id.`);
    return path.join(this.snapshotsDir, `${id}.json`);
  }

  writeManifest(body: Omit<Manifest, "checksum">): Manifest {
    const manifest: Manifest = { ...body, checksum: manifestChecksum(body) };
    writeFileAtomic(this.manifestFile(manifest.id), `${JSON.stringify(manifest)}\n`);
    return manifest;
  }

  readManifest(id: string): Manifest {
    const file = this.manifestFile(id);
    if (!existsSync(file)) throw new BackupError(`There is no snapshot "${id}" in ${this.root}.`);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    } catch {
      throw new BackupError(`The record of snapshot "${id}" is damaged.`);
    }
    const { checksum, ...body } = manifest;
    if (manifest.format !== 1 || checksum !== manifestChecksum(body)) {
      throw new BackupError(`The record of snapshot "${id}" is damaged.`);
    }
    return manifest;
  }

  /** Every readable snapshot, oldest first. Damaged records are listed separately. */
  list(): { manifests: Manifest[]; damaged: string[] } {
    const manifests: Manifest[] = [];
    const damaged: string[] = [];
    if (!existsSync(this.snapshotsDir)) return { manifests, damaged };
    for (const file of readdirSync(this.snapshotsDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      try {
        manifests.push(this.readManifest(id));
      } catch {
        damaged.push(id);
      }
    }
    manifests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { manifests, damaged };
  }

  deleteManifest(id: string): void {
    rmSync(this.manifestFile(id), { force: true });
  }

  /**
   * Removes blobs no snapshot refers to any more. Blobs younger than
   * `minAgeMs` are kept: a snapshot being written right now has stored its
   * blobs but not yet its manifest.
   */
  collectGarbage(minAgeMs: number = 24 * 60 * 60 * 1000): number {
    const { manifests, damaged } = this.list();
    // With a damaged record we cannot know what it referred to. Delete nothing.
    if (damaged.length > 0 || !existsSync(this.blobsDir)) return 0;
    const used = new Set<string>();
    for (const manifest of manifests) {
      used.add(manifest.db.sha256);
      for (const file of manifest.files) used.add(file.sha256);
    }
    let removed = 0;
    for (const prefix of readdirSync(this.blobsDir)) {
      const dir = path.join(this.blobsDir, prefix);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (used.has(name.replace(/\.gz$/, "")) || Date.now() - statSync(file).mtimeMs < minAgeMs) continue;
        rmSync(file);
        removed++;
      }
    }
    return removed;
  }

  /** Copies one snapshot into another store, verifying every blob it copies. */
  async copySnapshotTo(target: BackupStore, id: string): Promise<{ blobsCopied: number }> {
    const manifest = this.readManifest(id);
    let blobsCopied = 0;
    for (const sha256 of new Set([manifest.db.sha256, ...manifest.files.map((file) => file.sha256)])) {
      if (target.hasBlob(sha256)) continue;
      const source = this.blobPath(sha256);
      if (!existsSync(source)) throw new BackupError(`Backup content ${sha256.slice(0, 12)} is missing from ${this.root}.`);
      const temporary = target.tmpFile();
      await pipeline(createReadStream(source), createWriteStream(temporary));
      await flushToDisk(temporary);
      target.adoptBlob(temporary, sha256);
      // Re-read what landed on the other drive: external drives fail quietly.
      if (!(await target.verifyBlob(sha256))) {
        rmSync(target.blobPath(sha256), { force: true });
        throw new BackupError(`Copying ${sha256.slice(0, 12)} to ${target.root} did not verify.`);
      }
      blobsCopied++;
    }
    writeFileAtomic(target.manifestFile(id), `${JSON.stringify(manifest)}\n`);
    return { blobsCopied };
  }
}
