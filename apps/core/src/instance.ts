import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createSnapshot } from "./backup/snapshot.ts";
import { type Config, loadConfig, saveConfig } from "./config.ts";
import { loadMigrations, type Migration, MigrationError, planMigrations, runMigrations } from "./db/migrate.ts";
import { type Db, openDatabase, tableExists } from "./db/open.ts";
import { APP_ROOT, APP_VERSION, assertOutsideApp, type DataPaths, dataPaths, MIGRATIONS_DIR, SNAPSHOT_DIRS } from "./paths.ts";
import { type Logger, nowIso, silentLogger, writeFileAtomic } from "./util.ts";

// Opening an "instance" (one Home Base: its data folder and database) is the
// only way the core gets a database connection. Every rule that protects
// existing data on startup lives in this one function.

/** Thrown when starting would risk data. `help` lists what the owner can do. */
export class StartupRefused extends Error {
  readonly help: string[];
  /** "running" when another core holds the data folder; "data" for everything else. */
  readonly code: "running" | "data";
  constructor(message: string, help: string[] = [], code: "running" | "data" = "data") {
    super(message);
    this.name = "StartupRefused";
    this.help = help;
    this.code = code;
  }
}

export type Instance = {
  paths: DataPaths;
  db: Db;
  config: Config;
  instanceId: string;
  appVersion: string;
  schemaVersion: number;
  /** True when this call created the Home Base. */
  fresh: boolean;
  /** Migrations applied by this call. */
  migrated: number[];
  /** The snapshot taken before migrating, if any. */
  preMigrationSnapshot: string | null;
  close(): void;
};

export type OpenOptions = {
  dataDir: string;
  appRoot?: string;
  appVersion?: string;
  migrations?: Migration[];
  log?: Logger;
};

type InstanceFile = { format: 1; instanceId: string; createdAt: string };

function readInstanceFile(paths: DataPaths): InstanceFile | null {
  if (!existsSync(paths.instanceFile)) return null;
  try {
    return JSON.parse(readFileSync(paths.instanceFile, "utf8")) as InstanceFile;
  } catch {
    throw new StartupRefused(`${paths.instanceFile} is unreadable.`, ["Restore it from a snapshot, or ask for help before deleting it."]);
  }
}

function hasFiles(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() || hasFiles(path.join(dir, entry.name)));
}

/** Signs that this data folder held a Home Base before. */
function tracesOfEarlierUse(paths: DataPaths, instanceFile: InstanceFile | null): string[] {
  const traces: string[] = [];
  if (instanceFile) traces.push("an identity file (instance.json)");
  if (hasFiles(path.join(paths.backups, "snapshots"))) traces.push("backup snapshots");
  for (const dir of SNAPSHOT_DIRS) if (hasFiles(path.join(paths.root, dir))) traces.push(`files in ${dir}/`);
  return traces;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One core per data folder. Two writers would corrupt backups and restores. */
function acquireLock(paths: DataPaths): () => void {
  mkdirSync(path.dirname(paths.lockFile), { recursive: true });
  const mine = String(process.pid);
  try {
    writeFileSync(paths.lockFile, mine, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number(readFileSync(paths.lockFile, "utf8"));
    if (holder && holder !== process.pid && isAlive(holder)) {
      throw new StartupRefused(`Home Base is already running on this data folder (process ${holder}).`, ["Stop it first."], "running");
    }
    writeFileSync(paths.lockFile, mine); // the previous holder is gone
  }
  return () => {
    try {
      if (readFileSync(paths.lockFile, "utf8") === mine) rmSync(paths.lockFile);
    } catch {
      // already removed
    }
  };
}

function readMeta(db: Db, key: string): string | null {
  if (!tableExists(db, "meta")) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export async function openInstance(options: OpenOptions): Promise<Instance> {
  const log = options.log ?? silentLogger;
  const appVersion = options.appVersion ?? APP_VERSION;
  const paths = dataPaths(path.resolve(options.dataDir));
  assertOutsideApp(paths.root, options.appRoot ?? APP_ROOT);

  mkdirSync(paths.root, { recursive: true });
  const releaseLock = acquireLock(paths);
  let db: Db | undefined;
  try {
    const instanceFile = readInstanceFile(paths);
    const hadDatabase = existsSync(paths.dbFile);

    // Rule: never start blank where a Home Base used to be.
    if (!hadDatabase) {
      const traces = tracesOfEarlierUse(paths, instanceFile);
      if (traces.length > 0) {
        throw new StartupRefused(
          `The database is missing from ${paths.root}, but this folder was used before (found ${traces.join(", ")}). ` +
            "A new empty database was NOT created.",
          ["List snapshots:   npm run homebase -- backups list", "Restore one:      npm run homebase -- restore <snapshot>"],
        );
      }
    }

    const config = loadConfig(paths);
    for (const dir of [paths.dbDir, paths.vault, paths.files, paths.outputs, paths.snapshots, paths.backups, paths.logs]) {
      mkdirSync(dir, { recursive: true });
    }

    db = openDatabase(paths.dbFile);
    if (hadDatabase) {
      const check = db.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
      if (check?.quick_check !== "ok") {
        throw new StartupRefused(`The database in ${paths.root} is damaged (${check?.quick_check}). It was left untouched.`, [
          "Restore the newest snapshot:  npm run homebase -- restore <snapshot>",
        ]);
      }
    }

    const migrations = options.migrations ?? loadMigrations(MIGRATIONS_DIR);
    let plan: ReturnType<typeof planMigrations>;
    try {
      plan = planMigrations(db, migrations);
    } catch (error) {
      if (error instanceof MigrationError) throw new StartupRefused(error.message);
      throw error;
    }

    // An empty database file in a folder with traces of use is the same
    // situation as a missing one: something replaced the real database.
    if (hadDatabase && plan.current === 0) {
      const traces = tracesOfEarlierUse(paths, instanceFile);
      if (traces.length > 0) {
        throw new StartupRefused(
          `The database in ${paths.root} is empty, but this folder was used before (found ${traces.join(", ")}). Nothing was changed.`,
          ["Restore a snapshot:  npm run homebase -- restore <snapshot>"],
        );
      }
    }

    let instanceId = readMeta(db, "instance_id");
    if (instanceId && instanceFile && instanceFile.instanceId !== instanceId) {
      throw new StartupRefused(
        `${paths.root} mixes two different Home Bases: instance.json says ${instanceFile.instanceId}, the database says ${instanceId}.`,
      );
    }

    // Rule: snapshot before every schema change.
    let preMigrationSnapshot: string | null = null;
    if (plan.current > 0 && plan.pending.length > 0 && instanceId) {
      log.info(`Schema ${plan.current} → ${plan.latest}: taking a snapshot first.`);
      const { manifest } = await createSnapshot(
        { db, paths, instanceId, appVersion, schemaVersion: plan.current },
        { kind: "pre_migration", note: `before schema ${plan.current} to ${plan.latest}`, mirrors: config.backup.mirrors },
      );
      preMigrationSnapshot = manifest.id;
    }

    let migrated: number[];
    try {
      migrated = runMigrations(db, migrations, appVersion);
    } catch (error) {
      if (error instanceof MigrationError) {
        throw new StartupRefused(
          error.message,
          preMigrationSnapshot ? [`The database is unchanged. A snapshot from just before exists: ${preMigrationSnapshot}`] : [],
        );
      }
      throw error;
    }

    const fresh = !instanceId;
    if (!instanceId) {
      instanceId = instanceFile?.instanceId ?? randomUUID();
      writeMeta(db, "instance_id", instanceId);
      writeMeta(db, "created_at", nowIso());
    }
    if (!instanceFile) {
      writeFileAtomic(paths.instanceFile, `${JSON.stringify({ format: 1, instanceId, createdAt: readMeta(db, "created_at") ?? nowIso() }, null, 2)}\n`);
    }
    if (!existsSync(paths.configFile)) saveConfig(paths, config);
    if (fresh) log.info(`Created a new Home Base in ${paths.root}.`);
    if (migrated.length > 0) log.info(`Applied migration(s) ${migrated.join(", ")}.`);

    const opened = db;
    let closed = false;
    return {
      paths,
      db: opened,
      config,
      instanceId,
      appVersion,
      schemaVersion: plan.latest,
      fresh,
      migrated,
      preMigrationSnapshot,
      close() {
        if (closed) return;
        closed = true;
        if (opened.isOpen) opened.close();
        releaseLock();
      },
    };
  } catch (error) {
    if (db?.isOpen) db.close();
    releaseLock();
    throw error;
  }
}
