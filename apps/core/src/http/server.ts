import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { Helios } from "../ai/helios.ts";
import { StandInProvider } from "../ai/standin.ts";
import type { ModelProvider } from "../ai/types.ts";
import { AppError } from "../errors.ts";
import { EventBus } from "../events.ts";
import type { Instance } from "../instance.ts";
import { findSession, readCookie, SESSION_COOKIE, type Session } from "../security/sessions.ts";
import type { Logger } from "../util.ts";
import { registerHeliosRoutes } from "./heliosRoutes.ts";
import { registerRoutes } from "./routes.ts";

// The HTTP layer. Four rules are enforced here, in one place, for every
// request, so that no single route can forget them:
//
//   1. Host check      only requests addressed to this machine are answered
//   2. Session check   every /api route needs a login unless listed public
//   3. Origin check    requests that change something must come from our own page
//   4. No internals    errors never leak stack traces or SQL to the browser

export type ServerContext = {
  instance: Instance;
  log: Logger;
  /** The built screen (apps/web/dist). Optional: the API works without it. */
  webDir?: string;
  /** Extra host names to accept, used by the development server. */
  extraHosts?: string[];
  /** The models HELIOS may use. Without any, a rule-based stand-in answers. */
  providers?: ModelProvider[];
};

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

/** Routes that answer without a login. Everything else under /api needs one. */
export const PUBLIC_ROUTES = new Set(["GET /api/health", "GET /api/auth/session", "POST /api/auth/login"]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const SECURITY_HEADERS: Record<string, string> = {
  // Only load scripts, styles and data from this app itself.
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; " +
    "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), payment=()",
};

export async function buildServer(context: ServerContext): Promise<{ app: FastifyInstance; routes: string[]; helios: Helios; bus: EventBus }> {
  const { instance, log } = context;
  const { port } = instance.config.http;
  // forceCloseConnections: the event stream stays open for as long as the
  // screen is showing; shutting down must not wait for it.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, forceCloseConnections: true });
  const bus = new EventBus();
  const helios = new Helios({ instance, providers: context.providers ?? [new StandInProvider()], bus, log });
  const routes: string[] = [];

  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...(context.extraHosts ?? [])]);

  app.decorateRequest("session", null);
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) routes.push(`${method} ${route.url}`);
  });

  app.addHook("onRequest", async (request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);

    // 1. Host check. A malicious website can make a browser send requests to
    //    127.0.0.1 under its own host name ("DNS rebinding"). Those requests
    //    carry that site's name in the Host header, so they stop here.
    const host = request.headers.host ?? "";
    if (!allowedHosts.has(host)) return reply.code(421).send({ error: "This address is not served here." });

    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) return;
    reply.header("Cache-Control", "no-store");

    // 2. Session check, on the server, on every request. Hiding a button in
    //    the page protects nothing: anyone can call the address directly.
    request.session = findSession(instance.db, readCookie(request.headers.cookie, SESSION_COOKIE));
    const route = `${request.method} ${request.routeOptions.url ?? path}`;
    if (!PUBLIC_ROUTES.has(route) && !request.session) return reply.code(401).send({ error: "Not logged in." });

    // 3. Origin check. A browser attaches the session cookie to requests no
    //    matter which site started them, so another site could try to change
    //    data with the owner's login. Browsers always say where such a
    //    request came from; only our own page is accepted.
    if (!SAFE_METHODS.has(request.method)) {
      let originHost = "";
      try {
        originHost = new URL(request.headers.origin ?? "").host;
      } catch {
        originHost = "";
      }
      if (originHost !== host) return reply.code(403).send({ error: "Request came from another site." });
    }
  });

  // 4. Errors. Only messages written for the owner (AppError) are shown.
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ error: error.message });
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "That request could not be read." });
    }
    log.error(error.stack ?? String(error));
    return reply.code(500).send({ error: "Something went wrong on the server." });
  });

  registerRoutes(app, context);
  registerHeliosRoutes(app, helios, bus);

  const webDir = context.webDir && existsSync(context.webDir) ? context.webDir : null;
  // Files are looked up on each request, so a rebuilt screen is served
  // without restarting the core.
  if (webDir) await app.register(fastifyStatic, { root: webDir });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "There is nothing at this address." });
    // The screen is a single-page app: every other address shows it, and it
    // decides what to draw.
    if (webDir && request.method === "GET") return reply.sendFile("index.html");
    return reply.code(404).type("text/plain").send("The screen has not been built yet. Run: npm run build\n");
  });

  await app.ready();
  return { app, routes, helios, bus };
}

/** For routes that need step-up authentication (see docs/SECURITY.md). */
export function requireElevated(session: Session | null): void {
  if (!session?.elevated) throw new AppError(403, "Confirm your password first to do this.");
}
