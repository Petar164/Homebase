import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/open.ts";
import { newId } from "../util.ts";

// A session is "this browser is logged in". The browser holds a random
// token in a cookie; the database holds only the token's SHA-256 hash, so
// someone who reads the database still cannot log in.

export const SESSION_COOKIE = "hb_session";
const SESSION_DAYS = 30;
const ELEVATION_MINUTES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Session = {
  id: string;
  label: string;
  expiresAt: string;
  /** True for a few minutes after the owner re-entered their password. */
  elevated: boolean;
};

type Row = { id: string; label: string; last_seen_at: string; expires_at: string; elevated_until: string | null };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(db: Db, label = ""): { token: string; expiresAt: Date } {
  // 32 random bytes: impossible to guess, and it carries no information.
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS);
  db.prepare("INSERT INTO sessions (id, token_hash, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId(),
    hashToken(token),
    label.slice(0, 120),
    now.toISOString(),
    now.toISOString(),
    expiresAt.toISOString(),
  );
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString()); // housekeeping
  return { token, expiresAt };
}

/** Returns null for a missing, unknown or expired token. */
export function findSession(db: Db, token: string | undefined): Session | null {
  if (!token || token.length > 200) return null;
  const row = db
    .prepare("SELECT id, label, last_seen_at, expires_at, elevated_until FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as Row | undefined;
  const now = new Date();
  if (!row || row.expires_at < now.toISOString()) return null;
  // Remember when the session was last used, at most once an hour.
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 60 * 60 * 1000) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), row.id);
  }
  return {
    id: row.id,
    label: row.label,
    expiresAt: row.expires_at,
    elevated: row.elevated_until !== null && row.elevated_until > now.toISOString(),
  };
}

/** Logging out deletes the session on the server, so a copied cookie stops working too. */
export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function deleteAllSessions(db: Db): void {
  db.prepare("DELETE FROM sessions").run();
}

/**
 * Step-up authentication: after the owner proves who they are again, this
 * session may perform sensitive actions for a short while.
 */
export function elevateSession(db: Db, sessionId: string): Date {
  const until = new Date(Date.now() + ELEVATION_MINUTES * 60 * 1000);
  db.prepare("UPDATE sessions SET elevated_until = ? WHERE id = ?").run(until.toISOString(), sessionId);
  return until;
}

/** Reads one cookie from a raw Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > -1 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * The Set-Cookie value. Every flag closes a specific door:
 *   HttpOnly         JavaScript in the page cannot read it (limits XSS damage)
 *   SameSite=Strict  never sent on requests started by another site (CSRF)
 *   Secure           only sent over HTTPS (added whenever the page is HTTPS)
 */
export function sessionCookie(token: string, expires: Date | null, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  parts.push(expires ? `Expires=${expires.toUTCString()}` : "Max-Age=0");
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
