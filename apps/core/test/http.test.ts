import { existsSync } from "node:fs";
import type { Overview, Task } from "@homebase/shared";
import type { FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { BackupStore } from "../src/backup/store.ts";
import { buildServer, PUBLIC_ROUTES } from "../src/http/server.ts";
import { type Instance, openInstance } from "../src/instance.ts";
import { verifyAuditLog } from "../src/security/audit.ts";
import { setOwnerPassword } from "../src/security/owner.ts";
import { silentLogger } from "../src/util.ts";
import { sharedAcrossTests } from "./helpers.ts";

// One server for the whole file: hashing a password is slow on purpose.
// So its data folder has to last for the whole file too.
const shared = sharedAcrossTests();
const PASSWORD = "test-only password 1234";
const HOST = "localhost:7117";
const ORIGIN = `http://${HOST}`;

let instance: Instance;
let app: FastifyInstance;
let routes: string[];
let cookie = "";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

function call(method: Method, url: string, body?: unknown, options: { cookie?: string; origin?: string | null; host?: string } = {}) {
  const headers: Record<string, string> = { host: options.host ?? HOST };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  const sessionCookie = options.cookie ?? cookie;
  if (sessionCookie) headers.cookie = sessionCookie;
  return app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
}

beforeAll(async () => {
  instance = shared.track(await openInstance({ dataDir: shared.tempDir() }));
  await setOwnerPassword(instance.db, "owner", PASSWORD);
  ({ app, routes } = await buildServer({ instance, log: silentLogger }));
  shared.track(app); // when the file is over: the server closes, then the database, then the folder goes
});

describe("who gets in", () => {
  it("answers no data route without a login", async () => {
    const protectedRoutes = routes.filter((route) => route.includes("/api/") && !PUBLIC_ROUTES.has(route) && !route.startsWith("HEAD"));
    expect(protectedRoutes.length).toBeGreaterThan(8);
    for (const route of protectedRoutes) {
      const [method = "GET", url = ""] = route.split(" ");
      const response = await call(method as Method, url.replace(":id", "x"), method === "GET" ? undefined : {}, { cookie: "" });
      expect(response.statusCode, route).toBe(401);
    }
  });

  it("ignores requests addressed to another host name", async () => {
    expect((await call("GET", "/api/health", undefined, { host: "evil.example" })).statusCode).toBe(421);
  });

  it("rejects a wrong password with one vague message", async () => {
    const wrongPassword = await call("POST", "/api/auth/login", { username: "owner", password: "not the password" });
    const wrongUser = await call("POST", "/api/auth/login", { username: "nobody", password: PASSWORD });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongUser.json()).toEqual(wrongPassword.json());
  });

  it("logs the owner in with a cookie scripts cannot read", async () => {
    const response = await call("POST", "/api/auth/login", { username: "owner", password: PASSWORD });
    expect(response.statusCode).toBe(200);
    const header = String(response.headers["set-cookie"]);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    cookie = header.split(";")[0] ?? "";
    expect((await call("GET", "/api/auth/session")).json()).toMatchObject({ authenticated: true, username: "owner", elevated: false });
  });

  it("refuses changes that come from another site, even with the cookie", async () => {
    const body = { title: "Planted by another site", area: "inbox" };
    expect((await call("POST", "/api/tasks", body, { origin: "http://evil.example" })).statusCode).toBe(403);
    expect((await call("POST", "/api/tasks", body, { origin: null })).statusCode).toBe(403);
  });

  it("sends security headers and no internals", async () => {
    const response = await call("GET", "/api/tasks");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("no-store");

    const broken = await app.inject({ method: "POST", url: "/api/tasks", headers: { host: HOST, origin: ORIGIN, cookie, "content-type": "application/json" }, payload: "{not json" });
    expect(broken.statusCode).toBe(400);
    expect(broken.body).not.toMatch(/SyntaxError|Unexpected|node_modules|\.ts/);
  });
});

describe("tasks", () => {
  it("validates input instead of trusting it", async () => {
    expect((await call("POST", "/api/tasks", { title: "", area: "inbox" })).statusCode).toBe(400);
    expect((await call("POST", "/api/tasks", { title: "x", area: "not-an-area" })).statusCode).toBe(400);
    expect((await call("POST", "/api/tasks", { title: "x", area: "inbox", due: "2026-02-31" })).statusCode).toBe(400);
  });

  it("creates, completes and repeats a task, keeping the earlier version", async () => {
    const created = (await call("POST", "/api/tasks", { title: "Weekly review", area: "school", due: "2026-11-16", repeat: "w" })).json<Task>();
    expect(created).toMatchObject({ title: "Weekly review", repeat: "w", done: false });

    const { task, next } = (await call("PATCH", `/api/tasks/${created.id}`, { done: true, doneAt: "2026-11-16" })).json<{ task: Task; next: Task | null }>();
    expect(task.done).toBe(true);
    expect(next).toMatchObject({ title: "Weekly review", due: "2026-11-23", done: false });

    const revision = instance.db.prepare("SELECT data FROM record_revisions WHERE table_name = 'tasks' AND row_id = ?").get(created.id) as { data: string };
    expect(JSON.parse(revision.data)).toMatchObject({ done: 0 });
  });

  it("marks a deleted task instead of destroying it", async () => {
    const created = (await call("POST", "/api/tasks", { title: "Delete me", area: "inbox" })).json<Task>();
    expect((await call("DELETE", `/api/tasks/${created.id}`)).statusCode).toBe(200);
    expect((await call("GET", "/api/tasks")).json<Task[]>().some((task) => task.id === created.id)).toBe(false);
    expect((await call("PATCH", `/api/tasks/${created.id}`, { title: "ghost" })).statusCode).toBe(404);
    const row = instance.db.prepare("SELECT title, deleted_at FROM tasks WHERE id = ?").get(created.id) as { title: string; deleted_at: string | null };
    expect(row.title).toBe("Delete me");
    expect(row.deleted_at).not.toBeNull();
  });
});

// Invented data in the shape the Claude artifact version exports.
const EXPORT = {
  tasks: {
    "plan-a": { title: "Hand in the assignment", area: "school", due: "2026-11-20", done: false, createdAt: "2026-11-01T10:00:00.000Z", note: "" },
    "plan-b": { title: "Already finished", area: "coding", due: "2026-11-02", done: true, doneAt: "2026-11-02" },
    broken: { title: "", area: "school" },
  },
  events: { e1: { title: "Open mat", cat: "mma", date: "2026-11-03", s: "19:00", e: "20:30", repeat: "w", until: "" } },
  training: { "2026-11": { items: [{ date: "2026-11-10", time: "19:00", kind: "mma" }, { date: "not a date" }] } },
  ledger: {
    "2026-11": {
      items: [
        { date: "2026-11-05", desc: "Sample jacket", amount: 180, cost: 90, area: "business", kind: "in", inv: "FV-0001-2026", region: "NL", method: "PayPal" },
        { date: "2026-11-06", desc: "Packaging", amount: 12.5, area: "business", kind: "out", cat: "Shipping and packaging", vat: true },
      ],
    },
  },
  social: { s1: { name: "sample.account", platform: "Instagram", status: "active", goal: 1000, log: [{ d: "2026-11-01", n: 250 }] } },
  settings: { main: { currency: "EUR", vatRate: 21, classes: [{ d: 1, s: "09:00", e: "10:30", name: "Software", room: "B2" }], savings: { have: 100, goal: 500, log: [] } } },
};

describe("import and overview", () => {
  it("needs the password again before replacing data", async () => {
    expect((await call("POST", "/api/system/import", { data: EXPORT, replace: true })).statusCode).toBe(403);
    expect((await call("POST", "/api/auth/elevate", { password: "wrong one" })).statusCode).toBe(401);
    expect((await call("POST", "/api/auth/elevate", { password: PASSWORD })).statusCode).toBe(200);
  });

  it("refuses to overwrite records unless told to, and snapshots first", async () => {
    expect((await call("POST", "/api/system/import", { data: EXPORT })).statusCode).toBe(409);
    const result = (await call("POST", "/api/system/import", { data: EXPORT, replace: true })).json<{ summary: Record<string, unknown>; snapshot: string }>();
    expect(result.summary).toMatchObject({ tasks: 2, events: 1, training: 1, sales: 1, ledger: 1, social: 1, settings: true, skipped: 2 });
    // The tasks created earlier in this file are in that snapshot.
    expect(new BackupStore(instance.paths.backups).readManifest(result.snapshot).note).toBe("before import");
  });

  it("stores money as cents and sales apart from other entries", () => {
    const sale = instance.db.prepare("SELECT price_cents, cost_cents, invoice_number, status FROM sales").get();
    expect(sale).toMatchObject({ price_cents: 18000, cost_cents: 9000, invoice_number: "FV-0001-2026", status: "complete" });
    expect(instance.db.prepare("SELECT amount_cents, vat_reclaimable FROM ledger_entries").get()).toMatchObject({ amount_cents: 1250, vat_reclaimable: 1 });
  });

  it("builds the main screen from the imported records", async () => {
    const overview = (await call("GET", "/api/overview")).json<Overview>();
    expect(overview.openCount).toBe(1);
    expect(overview.focus?.title).toBe("Hand in the assignment");
    expect(overview.week).toHaveLength(7);
    expect(overview.week[0]?.classes[0]?.name).toBe("Software"); // Monday
    expect(overview.week[1]?.events[0]?.title).toBe("Open mat"); // weekly, on Tuesdays
    expect(overview.savings).toEqual({ have: 100, goal: 500 });
  });

  it("reports system health and leaves an intact audit trail", async () => {
    const status = (await call("GET", "/api/system/status")).json<{ snapshots: { count: number }; audit: { ok: boolean } }>();
    expect(status.snapshots.count).toBeGreaterThanOrEqual(1);
    expect(status.audit.ok).toBe(true);
    const actions = (instance.db.prepare("SELECT action FROM audit_log").all() as { action: string }[]).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.login_failed", "auth.login", "auth.elevate", "data.import"]));
    expect(verifyAuditLog(instance.db).ok).toBe(true);
  });

  it("logs out by deleting the session on the server", async () => {
    expect((await call("POST", "/api/auth/logout", {})).statusCode).toBe(200);
    expect((await call("GET", "/api/tasks")).statusCode).toBe(401); // the old cookie is now worthless
  });
});

describe("the server all these tests share", () => {
  // Its folder was once removed after the first test, with the database still
  // open in it. Windows refused; a Mac carried on with a deleted file.
  it("still has its data folder after the last of them", () => {
    expect(existsSync(instance.paths.dbFile)).toBe(true);
  });
});
