import { describe, expect, it } from "vitest";
import { createSnapshot } from "../src/backup/snapshot.ts";
import { openInstance } from "../src/instance.ts";
import { audit, verifyAuditLog } from "../src/security/audit.ts";
import { checkLoginAllowed, ownerExists, recordLoginAttempt, setOwnerPassword, verifyOwner } from "../src/security/owner.ts";
import { hashPassword, verifyPassword } from "../src/security/password.ts";
import { createSession, deleteSession, elevateSession, findSession, readCookie, sessionCookie } from "../src/security/sessions.ts";
import { tempDir, track } from "./helpers.ts";

const open = async () => track(await openInstance({ dataDir: tempDir() }));

describe("passwords", () => {
  it("stores a slow salted hash, never the password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterz", hash)).toBe(false);
  });

  it("has exactly one owner, created with a long enough password", async () => {
    const { db } = await open();
    expect(ownerExists(db)).toBe(false);
    await expect(setOwnerPassword(db, "petar", "short")).rejects.toThrow(/at least 12/);
    await setOwnerPassword(db, "petar", "a long enough password");
    expect(await verifyOwner(db, "petar", "a long enough password")).toBe(true);
    expect(await verifyOwner(db, "someone-else", "a long enough password")).toBe(false);
    expect(await verifyOwner(db, "petar", "wrong password here")).toBe(false);
  });
});

describe("sessions", () => {
  it("accepts only the exact token and forgets it on logout", async () => {
    const { db } = await open();
    const { token } = createSession(db, "test browser");
    expect(findSession(db, token)?.label).toBe("test browser");
    expect(findSession(db, `${token}x`)).toBeNull();
    expect(findSession(db, undefined)).toBeNull();
    // The database holds a hash, not the token.
    expect(JSON.stringify(db.prepare("SELECT * FROM sessions").all())).not.toContain(token);
    deleteSession(db, token);
    expect(findSession(db, token)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const { db } = await open();
    const { token } = createSession(db);
    db.prepare("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect(findSession(db, token)).toBeNull();
  });

  it("is elevated only for a limited time", async () => {
    const { db } = await open();
    const { token } = createSession(db);
    const session = findSession(db, token);
    expect(session?.elevated).toBe(false);
    elevateSession(db, session?.id as string);
    expect(findSession(db, token)?.elevated).toBe(true);
    db.prepare("UPDATE sessions SET elevated_until = ?").run(new Date(Date.now() - 1000).toISOString());
    expect(findSession(db, token)?.elevated).toBe(false);
  });

  it("sets a cookie scripts cannot read and other sites cannot send", () => {
    const cookie = sessionCookie("abc", new Date(Date.now() + 1000), true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(readCookie("a=1; hb_session=abc; b=2", "hb_session")).toBe("abc");
  });
});

describe("login guard", () => {
  it("locks the account after repeated failures and unlocks on success", async () => {
    const { db } = await open();
    for (let attempt = 0; attempt < 4; attempt++) recordLoginAttempt(db, "10.0.0.1", false);
    expect(checkLoginAllowed(db, "10.0.0.1").allowed).toBe(true);
    recordLoginAttempt(db, "10.0.0.2", false); // a different address: the account lock still counts it
    const locked = checkLoginAllowed(db, "10.0.0.3");
    expect(locked.allowed).toBe(false);
    if (!locked.allowed) expect(locked.retryAfterSeconds).toBeGreaterThan(0);

    // Failures older than the window no longer count.
    db.prepare("UPDATE login_attempts SET created_at = ?").run(new Date(Date.now() - 16 * 60 * 1000).toISOString());
    expect(checkLoginAllowed(db, "10.0.0.3").allowed).toBe(true);
  });
});

describe("audit log", () => {
  it("verifies an untouched log", async () => {
    const { db } = await open();
    audit(db, { actor: "owner", action: "auth.login" });
    audit(db, { actor: "helios", action: "task.create", target: "t1", detail: { title: "x" } });
    expect(verifyAuditLog(db)).toEqual({ ok: true, entries: 2 });
  });

  it("cannot be edited or deleted through the database", async () => {
    const { db } = await open();
    audit(db, { actor: "owner", action: "auth.login" });
    expect(() => db.prepare("UPDATE audit_log SET actor = 'nobody'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
  });

  it("detects an entry that was changed or removed behind its back", async () => {
    const instance = await open();
    const { db } = instance;
    for (const action of ["one", "two", "three"]) audit(db, { actor: "owner", action });
    const { manifest } = await createSnapshot(instance, { kind: "manual" }); // records the newest entry

    // An attacker with full database access removes the safety triggers.
    db.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;");

    db.prepare("UPDATE audit_log SET action = 'edited' WHERE seq = 2").run();
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, brokenAt: 2 });
    db.prepare("UPDATE audit_log SET action = 'two' WHERE seq = 2").run();
    expect(verifyAuditLog(db).ok).toBe(true);

    // Removing the newest entries leaves a valid shorter chain, but it no
    // longer matches what the snapshot recorded.
    db.prepare("DELETE FROM audit_log WHERE seq = 3").run();
    expect(verifyAuditLog(db).ok).toBe(true);
    expect(verifyAuditLog(db, manifest.auditHead)).toMatchObject({ ok: false, brokenAt: 3 });
  });
});
