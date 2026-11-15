import { loginSchema, type Overview, type SessionInfo, type SnapshotSummary, type SystemStatus, taskCreateSchema, taskUpdateSchema } from "@homebase/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSnapshot } from "../backup/snapshot.ts";
import { BackupStore } from "../backup/store.ts";
import { hasHomeBaseData, importExport } from "../domain/import.ts";
import { buildOverview } from "../domain/overview.ts";
import { createTask, deleteTask, listTasks, updateTask } from "../domain/tasks.ts";
import { AppError } from "../errors.ts";
import { summarise, systemStatus } from "../jobs/backups.ts";
import { audit } from "../security/audit.ts";
import { checkLoginAllowed, ownerExists, ownerUsername, recordLoginAttempt, verifyOwner } from "../security/owner.ts";
import { createSession, deleteSession, elevateSession, readCookie, SESSION_COOKIE, sessionCookie } from "../security/sessions.ts";
import { nowIso } from "../util.ts";
import { requireElevated, type ServerContext } from "./server.ts";

/**
 * Checks input against a schema. Rule: never trust the browser. Only the
 * fields the schema names get through; wrong types are refused.
 */
function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new AppError(400, `${where}${issue?.message ?? "That input is not valid."}`);
  }
  return result.data;
}

const idParams = z.object({ id: z.string().regex(/^[\w-]{1,64}$/) });
const passwordSchema = z.object({ password: z.string().min(1).max(256) });
const snapshotSchema = z.object({ note: z.string().trim().max(200).default("") }).prefault({});
const importSchema = z.object({ data: z.record(z.string(), z.unknown()), replace: z.boolean().default(false) });

export function registerRoutes(app: FastifyInstance, context: ServerContext): void {
  const { instance } = context;
  const { db } = instance;
  const startedAt = nowIso();

  /** Password guessing is slowed down wherever a password is checked. */
  function guardPasswordCheck(address: string): void {
    const guard = checkLoginAllowed(db, address);
    if (!guard.allowed) {
      throw new AppError(429, `Too many attempts. Try again in ${Math.ceil(guard.retryAfterSeconds / 60)} minute(s).`);
    }
  }

  app.get("/api/health", async () => ({ ok: true, version: instance.appVersion }));

  // ---------- login ----------

  app.get("/api/auth/session", async (request): Promise<SessionInfo> => ({
    authenticated: request.session !== null,
    ownerExists: ownerExists(db),
    elevated: request.session?.elevated ?? false,
    username: request.session ? ownerUsername(db) : null,
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const input = parse(loginSchema, request.body);
    guardPasswordCheck(request.ip);
    const ok = await verifyOwner(db, input.username, input.password);
    recordLoginAttempt(db, request.ip, ok);
    audit(db, { actor: ok ? "owner" : "unknown", action: ok ? "auth.login" : "auth.login_failed" });
    // One message for both mistakes, so it does not reveal whether the username exists.
    if (!ok) throw new AppError(401, "Wrong username or password.");
    const { token, expiresAt } = createSession(db, String(request.headers["user-agent"] ?? ""));
    reply.header("Set-Cookie", sessionCookie(token, expiresAt, request.protocol === "https"));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    deleteSession(db, readCookie(request.headers.cookie, SESSION_COOKIE));
    audit(db, { actor: "owner", action: "auth.logout" });
    reply.header("Set-Cookie", sessionCookie("", null, request.protocol === "https"));
    return { ok: true };
  });

  // Step-up authentication: re-enter the password to unlock sensitive
  // actions for a few minutes.
  app.post("/api/auth/elevate", async (request) => {
    const input = parse(passwordSchema, request.body);
    guardPasswordCheck(request.ip);
    const ok = await verifyOwner(db, ownerUsername(db) ?? "", input.password);
    recordLoginAttempt(db, request.ip, ok);
    audit(db, { actor: "owner", action: ok ? "auth.elevate" : "auth.elevate_failed" });
    if (!ok || !request.session) throw new AppError(401, "Wrong password.");
    return { ok: true, until: elevateSession(db, request.session.id).toISOString() };
  });

  // ---------- Home Base ----------

  app.get("/api/overview", async (): Promise<Overview> => buildOverview(db));

  app.get("/api/tasks", async () => listTasks(db));

  app.post("/api/tasks", async (request, reply) => {
    const task = createTask(db, parse(taskCreateSchema, request.body));
    return reply.code(201).send(task);
  });

  app.patch("/api/tasks/:id", async (request) => {
    const { id } = parse(idParams, request.params);
    return updateTask(db, id, parse(taskUpdateSchema, request.body), "owner");
  });

  app.delete("/api/tasks/:id", async (request) => {
    const { id } = parse(idParams, request.params);
    deleteTask(db, id, "owner");
    return { ok: true };
  });

  // ---------- system ----------

  app.get("/api/system/status", async (): Promise<SystemStatus> => systemStatus(instance, startedAt));

  app.get("/api/system/backups", async (): Promise<SnapshotSummary[]> =>
    new BackupStore(instance.paths.backups).list().manifests.map(summarise).reverse(),
  );

  app.post("/api/system/backups", async (request, reply) => {
    const { note } = parse(snapshotSchema, request.body ?? {});
    const { manifest, mirrors } = await createSnapshot(instance, { kind: "manual", note, mirrors: instance.config.backup.mirrors });
    audit(db, { actor: "owner", action: "backup.create", target: manifest.id, detail: { kind: "manual" } });
    return reply.code(201).send({ snapshot: summarise(manifest), mirrors });
  });

  // Replaces every Home Base record, so it needs step-up authentication and
  // always takes a snapshot of what it is about to replace.
  app.post("/api/system/import", { bodyLimit: 8 * 1024 * 1024 }, async (request) => {
    requireElevated(request.session);
    const input = parse(importSchema, request.body);
    let snapshot: string | null = null;
    if (hasHomeBaseData(db)) {
      if (!input.replace) throw new AppError(409, "There are already records here. Importing replaces them all; confirm to continue.");
      snapshot = (await createSnapshot(instance, { kind: "manual", note: "before import" })).manifest.id;
    }
    const summary = importExport(db, input.data, { replace: input.replace });
    audit(db, { actor: "owner", action: "data.import", detail: { ...summary, snapshot } });
    return { summary, snapshot };
  });
}
