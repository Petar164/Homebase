import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { readInstanceId, restoreSnapshot } from "./backup/restore.ts";
import { createSnapshot, initMirror, mirrorSnapshot, verifySnapshot } from "./backup/snapshot.ts";
import { BackupStore } from "./backup/store.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { hasHomeBaseData, importExport } from "./domain/import.ts";
import { type Instance, openInstance, StartupRefused } from "./instance.ts";
import { summarise, systemStatus } from "./jobs/backups.ts";
import { dataPaths, defaultDataDir } from "./paths.ts";
import { audit, verifyAuditLog } from "./security/audit.ts";
import { ownerUsername, setOwnerPassword } from "./security/owner.ts";
import { consoleLogger, nowIso } from "./util.ts";

// The `homebase` command: everything that is done on the machine itself
// rather than through the screen. Creating the owner account and restoring
// a snapshot are only possible here.

const HELP = `Usage: npm run homebase -- <command>

  status                              where the data is and how healthy it is
  owner set-password [username]       create the owner account or change the password
  backups list                        list snapshots, newest first
  backups create [note]               take a snapshot now
  backups verify [snapshot]           re-check a snapshot's content (default: the newest)
  backups add-mirror <folder>         also keep backups in this folder (external drive)
  backups sync                        copy missing snapshots to the mirrors
  restore <snapshot> [--from <folder>] [--yes]
                                      replace the data with a snapshot
  audit verify                        check that the audit log was not altered
  import <file> [--replace]           import an export of the earlier Home Base
`;

const dataDir = defaultDataDir();
const paths = dataPaths(dataDir);

let pipedLines: string[] | null = null;

function ask(question: string, hidden = false): Promise<string> {
  // When input is piped in (a script), read it all once and answer in order.
  if (!process.stdin.isTTY) {
    pipedLines ??= readFileSync(0, "utf8").split(/\r?\n/);
    return Promise.resolve(pipedLines.shift() ?? "");
  }
  return new Promise((resolve) => {
    const terminal = true;
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal });
    if (hidden && terminal) {
      // Do not echo what is typed.
      (reader as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
        if (text.includes(question)) process.stdout.write(question);
      };
    }
    reader.question(question, (answer) => {
      reader.close();
      if (hidden && terminal) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function withInstance<T>(work: (instance: Instance) => Promise<T>): Promise<T> {
  const instance = await openInstance({ dataDir, log: consoleLogger });
  try {
    return await work(instance);
  } finally {
    instance.close();
  }
}

async function main(args: string[]): Promise<void> {
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const fromIndex = args.indexOf("--from");
  const fromFolder = fromIndex > -1 ? args[fromIndex + 1] : undefined;
  const fromValueIndex = fromIndex > -1 ? fromIndex + 1 : -1;
  const words = args.filter((arg, index) => !arg.startsWith("--") && index !== fromValueIndex);
  const [command, second, third] = words;

  switch (`${command ?? ""} ${command === "backups" || command === "owner" || command === "audit" ? (second ?? "") : ""}`.trim()) {
    case "status": {
      console.log(`Data folder:  ${paths.root}`);
      if (!existsSync(paths.dbFile)) return console.log("No Home Base here yet. It is created the first time the core starts.");
      await withInstance(async (instance) => {
        const status = systemStatus(instance, nowIso());
        console.log(`Version:      ${status.version} (schema ${status.schemaVersion})`);
        console.log(`Owner:        ${ownerUsername(instance.db) ?? "not created yet"}`);
        console.log(`Snapshots:    ${status.snapshots.count}${status.snapshots.newestAt ? `, newest ${status.snapshots.newestAt} (${status.snapshots.newestKind})` : ""}`);
        for (const mirror of status.mirrors) {
          console.log(`Mirror:       ${mirror.path}  ${mirror.connected ? `connected, newest ${mirror.newestAt ?? "none"}` : "NOT CONNECTED"}`);
        }
        if (status.mirrors.length === 0) console.log("Mirror:       none. Add the external drive with: backups add-mirror <folder>");
        console.log(`Audit log:    ${status.audit.entries} entries, ${status.audit.ok ? "intact" : "CHAIN BROKEN"}`);
      });
      return;
    }

    case "owner set-password": {
      await withInstance(async (instance) => {
        const username = third ?? ownerUsername(instance.db) ?? (await ask("Username: "));
        const password = await ask("New password (at least 12 characters): ", true);
        if (password !== (await ask("Repeat it: ", true))) fail("The two passwords differ. Nothing was changed.");
        await setOwnerPassword(instance.db, username, password);
        audit(instance.db, { actor: "cli", action: "owner.set_password" });
        console.log(`Password set for "${username}". Every browser has been logged out.`);
      });
      return;
    }

    case "backups list": {
      const { manifests, damaged } = new BackupStore(paths.backups).list();
      if (manifests.length === 0) console.log("No snapshots yet.");
      for (const manifest of manifests.reverse()) {
        const s = summarise(manifest);
        console.log(`${s.id}   schema ${s.schemaVersion}   ${s.files} files   ${size(s.bytes)}${s.note ? `   ${s.note}` : ""}`);
      }
      for (const id of damaged) console.log(`${id}   DAMAGED RECORD`);
      return;
    }

    case "backups create": {
      await withInstance(async (instance) => {
        const { manifest, mirrors } = await createSnapshot(instance, { kind: "manual", note: third ?? "", mirrors: instance.config.backup.mirrors });
        audit(instance.db, { actor: "cli", action: "backup.create", target: manifest.id, detail: { kind: "manual" } });
        console.log(`Snapshot ${manifest.id} taken.`);
        for (const mirror of mirrors) console.log(`  mirror ${mirror.path}: ${mirror.status} (${mirror.detail})`);
      });
      return;
    }

    case "backups verify": {
      const store = new BackupStore(fromFolder ?? paths.backups);
      const id = third ?? store.list().manifests.at(-1)?.id ?? fail("No snapshots to verify.");
      const verdict = await verifySnapshot(store, id);
      if (verdict.ok) return console.log(`Snapshot ${id}: every file is present and intact.`);
      for (const file of verdict.missing) console.log(`  missing: ${file}`);
      for (const file of verdict.damaged) console.log(`  damaged: ${file}`);
      fail(`Snapshot ${id} is NOT complete.`);
      return;
    }

    case "backups add-mirror": {
      const folder = path.resolve(third ?? fail("Give the folder, for example: backups add-mirror E:\\HomeBaseBackups"));
      const instanceId = readInstanceId(paths) ?? fail("Start the core once first, so this Home Base has an identity.");
      initMirror(folder, instanceId);
      const config = loadConfig(paths);
      if (!config.backup.mirrors.includes(folder)) config.backup.mirrors.push(folder);
      saveConfig(paths, config);
      const result = await mirrorSnapshot(new BackupStore(paths.backups), folder);
      console.log(`Mirror added: ${folder} (${result.detail}). Restart the core to pick it up.`);
      return;
    }

    case "backups sync": {
      const store = new BackupStore(paths.backups);
      for (const folder of loadConfig(paths).backup.mirrors) {
        const result = await mirrorSnapshot(store, folder);
        console.log(`${folder}: ${result.status} (${result.detail})`);
      }
      return;
    }

    case "restore": {
      const id = second ?? fail("Give the snapshot to restore. See: backups list");
      const store = new BackupStore(fromFolder ?? paths.backups);
      const manifest = store.readManifest(id);
      console.log(`Restore snapshot ${id} (taken ${manifest.createdAt}, schema ${manifest.schemaVersion}) into ${paths.root}.`);
      console.log("The current data is snapshotted first and the replaced folders are kept.");
      if (!flags.has("--yes") && (await ask('Type RESTORE to continue: ')) !== "RESTORE") fail("Cancelled. Nothing was changed.");

      let current: Instance | null = null;
      try {
        if (existsSync(paths.dbFile)) current = await openInstance({ dataDir });
      } catch (error) {
        // A running core must be stopped first. Any other refusal (missing
        // or damaged data) is exactly the situation a restore is for.
        if (error instanceof StartupRefused && error.code === "running") fail(error.message);
        console.log(`The current data cannot be opened (${(error as Error).message}). It will be moved aside, not deleted.`);
      }
      try {
        const result = await restoreSnapshot({ paths, store, snapshotId: id, current });
        console.log("Restored.");
        if (result.preRestoreSnapshot) console.log(`  Snapshot of what was replaced: ${result.preRestoreSnapshot}`);
        if (result.replacedDir) console.log(`  Replaced folders kept in:      ${result.replacedDir}`);
      } finally {
        current?.close();
      }
      return;
    }

    case "audit verify": {
      await withInstance(async (instance) => {
        const verdict = verifyAuditLog(instance.db);
        if (verdict.ok) return console.log(`Audit log intact: ${verdict.entries} entries.`);
        fail(`Audit log BROKEN at entry ${verdict.brokenAt}: ${verdict.reason}.`);
      });
      return;
    }

    case "import": {
      const file = second ?? fail("Give the export file to import.");
      const data: unknown = JSON.parse(readFileSync(file, "utf8"));
      await withInstance(async (instance) => {
        if (hasHomeBaseData(instance.db)) {
          if (!flags.has("--replace")) fail("There are already records here. Importing replaces them all. Add --replace to confirm.");
          const { manifest } = await createSnapshot(instance, { kind: "manual", note: "before import" });
          console.log(`Snapshot taken first: ${manifest.id}`);
        }
        const summary = importExport(instance.db, data, { replace: flags.has("--replace") });
        audit(instance.db, { actor: "cli", action: "data.import", detail: summary });
        console.log("Imported:", summary);
      });
      return;
    }

    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((error: Error) => {
  if (error instanceof StartupRefused) {
    console.error(`\n${error.message}\n`);
    for (const line of error.help) console.error(`  ${line}`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
