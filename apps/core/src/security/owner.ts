import { createHash } from "node:crypto";
import type { Db } from "../db/open.ts";
import { hashPassword, MIN_PASSWORD_LENGTH, verifyAgainstDummy, verifyPassword } from "./password.ts";
import { deleteAllSessions } from "./sessions.ts";

// The single owner account, and the brakes on password guessing.

type OwnerRow = { username: string; password_hash: string };

export function ownerExists(db: Db): boolean {
  return db.prepare("SELECT 1 FROM owner WHERE id = 1").get() !== undefined;
}

/**
 * Creates the owner or changes the password. Only reachable from the
 * command line on the machine itself: there is no sign-up route.
 * Changing the password logs every browser out.
 */
export async function setOwnerPassword(db: Db, username: string, password: string): Promise<void> {
  const name = username.trim();
  if (!name || name.length > 64) throw new Error("Choose a username of 1 to 64 characters.");
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO owner (id, username, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
  ).run(name, hash, now, now);
  deleteAllSessions(db);
  db.prepare("DELETE FROM login_attempts").run(); // also clears a lockout
}

/** True only for the right username and password. Takes the same time either way. */
export async function verifyOwner(db: Db, username: string, password: string): Promise<boolean> {
  const owner = db.prepare("SELECT username, password_hash FROM owner WHERE id = 1").get() as OwnerRow | undefined;
  if (!owner || owner.username.toLowerCase() !== username.trim().toLowerCase()) return verifyAgainstDummy(password);
  return verifyPassword(password, owner.password_hash);
}

export function ownerUsername(db: Db): string | null {
  return (db.prepare("SELECT username FROM owner WHERE id = 1").get() as { username: string } | undefined)?.username ?? null;
}

// ---------- login guard ----------
//
// Two brakes, both counted in the database so they survive a restart:
//   1. per address: too many failures from one address and it has to wait
//   2. per account: too many failures on the account and nobody can log in
//      until the window passes, whatever address they come from
// Trade-off: someone who keeps guessing can keep the real owner out too.
// The window is short for that reason, and setting the password from the
// command line clears it.

const WINDOW_MINUTES = 15;
const MAX_FAILS_PER_ADDRESS = 10;
const MAX_FAILS_PER_ACCOUNT = 5;

export type GuardResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function addressKey(address: string): string {
  return `ip:${createHash("sha256").update(address).digest("hex").slice(0, 32)}`;
}

function failuresInWindow(db: Db, key: string, since: string): string[] {
  // Only failures after the last success count, so a correct login clears the slate.
  const lastSuccess = db
    .prepare("SELECT created_at FROM login_attempts WHERE key = ? AND succeeded = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
    .get(key, since) as { created_at: string } | undefined;
  const rows = db
    .prepare("SELECT created_at FROM login_attempts WHERE key = ? AND succeeded = 0 AND created_at > ? ORDER BY created_at")
    .all(key, lastSuccess?.created_at ?? since) as { created_at: string }[];
  return rows.map((row) => row.created_at);
}

function check(db: Db, key: string, limit: number): GuardResult {
  const windowMs = WINDOW_MINUTES * 60 * 1000;
  const failures = failuresInWindow(db, key, new Date(Date.now() - windowMs).toISOString());
  if (failures.length < limit) return { allowed: true };
  // Blocked until the oldest counted failure falls out of the window.
  const oldest = new Date(failures[failures.length - limit] ?? failures[0] ?? Date.now()).getTime();
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000)) };
}

/** Call before checking the password. */
export function checkLoginAllowed(db: Db, address: string): GuardResult {
  const byAddress = check(db, addressKey(address), MAX_FAILS_PER_ADDRESS);
  if (!byAddress.allowed) return byAddress;
  return check(db, "account", MAX_FAILS_PER_ACCOUNT);
}

/** Call after checking the password, with the outcome. */
export function recordLoginAttempt(db: Db, address: string, succeeded: boolean): void {
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT INTO login_attempts (key, succeeded, created_at) VALUES (?, ?, ?)");
  insert.run(addressKey(address), succeeded ? 1 : 0, now);
  insert.run("account", succeeded ? 1 : 0, now);
  db.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}
