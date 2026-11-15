import { createHash } from "node:crypto";
import { type Db, transaction } from "../db/open.ts";

// The audit log answers "what happened, and can I trust this record?".
//
// Every entry stores the hash of the entry before it, and its own hash is
// computed over that plus its own content. Change or remove one entry and
// every hash after it stops matching: the chain "breaks" at that point.
// The database also rejects UPDATE and DELETE on the table (see migration
// 0001), and every snapshot records the newest hash, so a tampered log
// would also disagree with older backups.

const GENESIS = "0".repeat(64);

type Row = { seq: number; at: string; actor: string; action: string; target: string; detail: string; prev_hash: string; hash: string };

function entryHash(prev: string, entry: Pick<Row, "at" | "actor" | "action" | "target" | "detail">): string {
  return createHash("sha256")
    .update(JSON.stringify([prev, entry.at, entry.actor, entry.action, entry.target, entry.detail]))
    .digest("hex");
}

/**
 * Appends one entry. `actor` is who did it ("owner", "helios", "system",
 * "cli"), `action` is a dotted name ("auth.login", "backup.create").
 * Never put secrets in `detail`.
 */
export function audit(db: Db, entry: { actor: string; action: string; target?: string; detail?: Record<string, unknown> }): void {
  transaction(db, () => {
    const last = db.prepare("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
    const prev = last?.hash ?? GENESIS;
    const row = {
      at: new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      target: entry.target ?? "",
      detail: JSON.stringify(entry.detail ?? {}),
    };
    db.prepare("INSERT INTO audit_log (at, actor, action, target, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      row.at,
      row.actor,
      row.action,
      row.target,
      row.detail,
      prev,
      entryHash(prev, row),
    );
  });
}

export type AuditVerdict = { ok: true; entries: number } | { ok: false; entries: number; brokenAt: number; reason: string };

/**
 * Walks the whole chain. `anchor` is an entry recorded outside the database
 * (in a snapshot manifest): the log must still contain exactly that entry.
 */
export function verifyAuditLog(db: Db, anchor?: { seq: number; hash: string } | null): AuditVerdict {
  const rows = db.prepare("SELECT seq, at, actor, action, target, detail, prev_hash, hash FROM audit_log ORDER BY seq").all() as Row[];
  let prev = GENESIS;
  let anchorSeen = !anchor;
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      return { ok: false, entries: rows.length, brokenAt: row.seq, reason: "an entry before this one was removed or changed" };
    }
    if (entryHash(prev, row) !== row.hash) {
      return { ok: false, entries: rows.length, brokenAt: row.seq, reason: "this entry was changed" };
    }
    if (anchor && row.seq === anchor.seq) {
      if (row.hash !== anchor.hash) {
        return { ok: false, entries: rows.length, brokenAt: row.seq, reason: "this entry differs from the copy recorded in a snapshot" };
      }
      anchorSeen = true;
    }
    prev = row.hash;
  }
  if (!anchorSeen) {
    return { ok: false, entries: rows.length, brokenAt: anchor?.seq ?? 0, reason: "an entry recorded in a snapshot is no longer in the log" };
  }
  return { ok: true, entries: rows.length };
}
