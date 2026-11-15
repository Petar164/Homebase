import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- where the app's code lives ----------

/** The folder that holds the app's code (the repository root). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const MIGRATIONS_DIR = path.join(APP_ROOT, "apps", "core", "migrations");
export const WEB_DIST_DIR = path.join(APP_ROOT, "apps", "web", "dist");
export const APP_VERSION: string = JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version;

// ---------- where the data lives ----------

/**
 * The data folder holds everything that must survive updates. It is never
 * inside the app folder, so deleting, replacing or updating the app cannot
 * touch it.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.HOMEBASE_DATA_DIR) return path.resolve(env.HOMEBASE_DATA_DIR);
  const home = os.homedir();
  if (platform === "win32") return path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "HomeBase");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "HomeBase");
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "homebase");
}

export type DataPaths = ReturnType<typeof dataPaths>;

export function dataPaths(root: string) {
  return {
    root,
    instanceFile: path.join(root, "instance.json"),
    configFile: path.join(root, "config.json"),
    dbDir: path.join(root, "db"),
    dbFile: path.join(root, "db", "homebase.sqlite"),
    vault: path.join(root, "vault"),
    files: path.join(root, "files"),
    outputs: path.join(root, "outputs"),
    snapshots: path.join(root, "snapshots"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
    replaced: path.join(root, "replaced"),
    lockFile: path.join(root, "run", "core.lock"),
  };
}

/** Folders whose files are part of every snapshot, relative to the data folder. */
export const SNAPSHOT_DIRS = ["vault", "files", "outputs", "snapshots"] as const;

/** True when `child` is `parent` or somewhere inside it. */
export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Refuses a data folder inside the app folder. That layout is exactly what
 * makes an update or a fresh download wipe saved data.
 */
export function assertOutsideApp(dataDir: string, appRoot: string = APP_ROOT): void {
  if (isInside(dataDir, appRoot)) {
    throw new Error(
      `The data folder (${dataDir}) is inside the app folder (${appRoot}). ` +
        "Data must live outside the app so updates can never touch it. Choose another HOMEBASE_DATA_DIR.",
    );
  }
}
