import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { buildServer, isApiRequest } from "../src/http/server.ts";
import { type Instance, openInstance } from "../src/instance.ts";
import { APP_ROOT } from "../src/paths.ts";
import { createSession, SESSION_COOKIE } from "../src/security/sessions.ts";
import { silentLogger } from "../src/util.ts";
import { insertTask, sharedAcrossTests, taskTitles } from "./helpers.ts";

// How the core serves the screen's files next to its protected routes, and
// what happens when an address is spelled in a way a browser never would.
//
// These tests talk to a real listening server over a plain socket. A test
// client that takes a URL would tidy the address up first ("/a/../b"
// becomes "/b"), and an attacker's client does not.

const HOST = "localhost:7117";
/** Text that exists only in a file outside the screen's folder. */
const OUTSIDE = "OUTSIDE-THE-WEB-FOLDER";
/** Text that exists only in dot-named files inside the screen's folder. */
const DOTTED = "IN-A-DOT-NAMED-FILE";
/** Text that exists only in a record behind the login. */
const RECORD = "A task only the owner may see";

const SCREEN = "<title>Home Base</title>";
const REFUSED = JSON.stringify({ error: "That request could not be read." });
const NOT_LOGGED_IN = JSON.stringify({ error: "Not logged in." });
/** What a request gets that is not valid HTTP at all (an address that does not start with a slash). It never reaches the router. */
const NOT_HTTP = JSON.stringify({ error: "Bad Request", message: "Client Error", statusCode: 400 });

const shared = sharedAcrossTests();
let instance: Instance;
let app: FastifyInstance;
let routes: string[] = [];
let port = 0;
let cookie = "";
/** The folder the screen is served from. */
let webDir = "";
/** The file outside the web folder, as an absolute path with forward slashes. On Windows it starts with a drive letter. */
let outsideFile = "";

type Answer = { status: number; headers: Record<string, string>; body: string };

/** Sends one request exactly as written, with no client in between to clean up the address. */
function raw(method: string, target: string, options: { cookie?: string; origin?: string; body?: string; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.setTimeout(5000, () => socket.destroy(new Error(`no answer to ${method} ${target}`)));
    socket.on("error", reject);
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const [statusLine = "", ...headerLines] = text.slice(0, split === -1 ? text.length : split).split("\r\n");
      const headers = Object.fromEntries(headerLines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
      let body = split === -1 ? "" : text.slice(split + 4);
      if (headers["transfer-encoding"] === "chunked") {
        // "size in hex, line break, that many bytes, line break", until a size of zero.
        let rest = body;
        body = "";
        for (;;) {
          const lineEnd = rest.indexOf("\r\n");
          const size = Number.parseInt(rest.slice(0, lineEnd), 16);
          if (!(size > 0)) break;
          body += rest.slice(lineEnd + 2, lineEnd + 2 + size);
          rest = rest.slice(lineEnd + 2 + size + 2);
        }
      }
      resolve({ status: Number(statusLine.split(" ")[1] ?? 0), headers, body });
    });
    const lines = [`${method} ${target} HTTP/1.1`, `Host: ${options.host ?? HOST}`, "Connection: close"];
    if (options.cookie) lines.push(`Cookie: ${options.cookie}`);
    if (options.origin) lines.push(`Origin: ${options.origin}`);
    if (options.body !== undefined) lines.push("Content-Type: application/json", `Content-Length: ${Buffer.byteLength(options.body)}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n${options.body ?? ""}`);
  });
}

beforeAll(async () => {
  // A folder with one file that must never be served, and inside it the
  // folder the screen is served from.
  const outer = shared.tempDir();
  webDir = path.join(outer, "web");
  mkdirSync(path.join(webDir, "assets"), { recursive: true });
  mkdirSync(path.join(webDir, ".git"), { recursive: true });
  writeFileSync(path.join(outer, "secret.txt"), OUTSIDE);
  writeFileSync(path.join(webDir, "index.html"), `<!doctype html>${SCREEN}<div id=root></div>`);
  writeFileSync(path.join(webDir, "assets", "app.js"), "console.log('the screen');");
  // Files a tool might leave behind in the folder. They are not part of the screen.
  writeFileSync(path.join(webDir, ".env"), DOTTED);
  writeFileSync(path.join(webDir, ".git", "config"), DOTTED);
  writeFileSync(path.join(webDir, "assets", ".DS_Store"), DOTTED);
  outsideFile = path.join(outer, "secret.txt").split(path.sep).join("/");

  instance = shared.track(await openInstance({ dataDir: shared.tempDir() }));
  insertTask(instance, "t1", RECORD);
  cookie = `${SESSION_COOKIE}=${createSession(instance.db, "test").token}`;
  ({ app, routes } = await buildServer({ instance, log: silentLogger, webDir }));
  shared.track(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

describe("the screen's own files", () => {
  it("are served without a login, and any other address shows the screen", async () => {
    const page = await raw("GET", "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain(SCREEN);
    const script = await raw("GET", "/assets/app.js");
    expect(script.status).toBe(200);
    expect(script.body).toContain("the screen");
    expect(script.headers["content-type"]).toMatch(/javascript/);
    // The screen is a single page: an address it does not know as a file is still the screen.
    for (const address of ["/sales/2026", "/assets/", "/assets", "/secret.txt", "/index.html"]) {
      const answer = await raw("GET", address);
      expect(answer.status, address).toBe(200);
      expect(answer.body, address).toContain(SCREEN);
    }
    // The rules that hold for every request hold here too.
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await raw("GET", "/", { host: "other.example.net" })).status).toBe(421);
    expect((await raw("POST", "/sales/2026", { body: "{}", origin: `http://${HOST}` })).status).toBe(404);
  });

  it("never include a file from outside the screen's folder, however the address is spelled", async () => {
    // The file's own path, written the way a client puts a path into an address (a space becomes "%20").
    const itsPath = encodeURI(outsideFile);
    const attempts = [
      // Dot segments, plain and encoded, single and double.
      "/../secret.txt",
      "/../../secret.txt",
      "/assets/../../secret.txt",
      "/assets/../../../secret.txt",
      "/./../secret.txt",
      "/assets/./../../secret.txt",
      "/%2e%2e/secret.txt",
      "/%2E%2E/secret.txt",
      "/.%2e/secret.txt",
      "/%2e./secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/%252e%252e/secret.txt",
      "/assets/%252e%252e/%252e%252e/secret.txt",
      // Encoded and doubled separators.
      "/..%2fsecret.txt",
      "/..%2Fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets%2f..%2f..%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/..%252fsecret.txt",
      "//../secret.txt",
      "/assets//..//..//secret.txt",
      // Backslashes, which are separators on Windows.
      "/..\\secret.txt",
      "/..%5csecret.txt",
      "/..%5Csecret.txt",
      "/assets\\..\\..\\secret.txt",
      "/assets/..%5c..%5csecret.txt",
      "/%5c..%5csecret.txt",
      // Other tricks: a segment that some servers cut off, bytes that some decode twice, a path through a file.
      "/assets/..;/../secret.txt",
      "/..;/secret.txt",
      "/..%c0%afsecret.txt",
      "/..%ef%bc%8fsecret.txt",
      "/assets/app.js/../../../secret.txt",
      "/index.html/../../secret.txt",
      "/secret.txt%00.html",
      "/../secret.txt%00",
      // The file's own full path. On Windows it starts with a drive letter and not with a slash.
      itsPath,
      `/${itsPath}`,
      `/${encodeURIComponent(outsideFile)}`,
      `/assets/../../../../../../../../../../${itsPath}`,
      `/file://${itsPath}`,
      // The shapes such a path has on Windows, so that a run on any machine meets them.
      "C:/Users/someone/secret.txt",
      "C:\\Users\\someone\\secret.txt",
      "/C:/Users/someone/secret.txt",
      "/C:\\Users\\someone\\secret.txt",
      "/C%3A%2FUsers%2Fsomeone%2Fsecret.txt",
      "//?/C:/Users/someone/secret.txt",
    ];
    for (const attempt of attempts) {
      // An address that does not start with a slash is not a valid request. It is turned away before the router sees it, in the words for that.
      const refusals = attempt.startsWith("/") ? [REFUSED] : [REFUSED, NOT_HTTP];
      const answer = await raw("GET", attempt);
      expect(answer.body, `GET ${attempt}`).not.toContain(OUTSIDE);
      // The screen itself, or a plain refusal. Never the file, and never an error from inside the server.
      expect([SCREEN, ...refusals].some((expected) => answer.body.includes(expected)), `GET ${attempt} answered ${answer.status}: ${answer.body.slice(0, 80)}`).toBe(true);
      expect([200, 400, 403], `GET ${attempt} answered ${answer.status}`).toContain(answer.status);
      // Asking only for the headers gives no more away. (An address that is no file is "not found" here, where GET shows the screen.)
      const head = await raw("HEAD", attempt);
      expect(attempt.startsWith("/") ? [""] : ["", NOT_HTTP], `HEAD ${attempt} answered ${head.status}: ${head.body.slice(0, 80)}`).toContain(head.body);
      expect([200, 400, 403, 404], `HEAD ${attempt} answered ${head.status}`).toContain(head.status);
    }
  });

  it("are found under their plain address only", async () => {
    // "/assets//app.js" and "/assets/x/../app.js" name the same file as
    // "/assets/app.js". A server that answers them the same lets an address
    // slip past any rule written for the plain form, so they are refused.
    for (const address of ["/assets//app.js", "//assets/app.js", "/assets/./app.js", "/./assets/app.js", "/assets/x/../app.js", "/x/../assets/app.js", "/assets/%2e/app.js", "/x/%2e%2e/assets/app.js", "/assets\\app.js", "/assets/app.js%00"]) {
      const answer = await raw("GET", address);
      expect(answer.body, address).not.toContain("the screen");
      expect(answer.status, address).toBe(403);
      expect(answer.body, address).toBe(REFUSED);
    }
    // Other names a file system may have for the same file: other letter
    // case on a Mac and on Windows, and on Windows also a trailing dot or
    // space, or the file's data stream. Where the machine reads such a name
    // as the file, the address is refused. Where it does not, there is no
    // such file, and the address shows the screen like any other.
    for (const address of ["/ASSETS/APP.JS", "/Assets/app.js", "/assets/App.js", "/assets/app.JS", "/assets/app.js.", "/assets/app.js%20", "/assets/app.js::$DATA"]) {
      const readAsTheFile = existsSync(path.join(webDir, ...decodeURIComponent(address).split("/").filter(Boolean)));
      const answer = await raw("GET", address);
      const where = `${address} (${readAsTheFile ? "another name for the file on this machine" : "no such file on this machine"})`;
      expect(answer.body, where).not.toContain("the screen");
      expect(answer.status, where).toBe(readAsTheFile ? 403 : 200);
      expect(answer.body.includes(readAsTheFile ? REFUSED : SCREEN), `${where} answered: ${answer.body.slice(0, 80)}`).toBe(true);
    }
  });

  it("are served by a version of the file server that has the published fixes", () => {
    // The fixes this relies on, by the version that brought them: 10.1.1 and
    // 10.1.2 (addresses that are not in their plain form), 10.1.4 (letter
    // case on file systems that ignore it), 10.1.12 (dot-named folders).
    const { version } = JSON.parse(readFileSync(path.join(APP_ROOT, "node_modules", "@fastify", "static", "package.json"), "utf8")) as { version: string };
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    expect(major * 1_000_000 + minor * 1000 + patch, `@fastify/static ${version}`).toBeGreaterThanOrEqual(10_001_012);
  });

  it("do not include files whose name starts with a dot", async () => {
    for (const address of ["/.env", "/.git/config", "/assets/.DS_Store", "/%2eenv", "/%2Egit/config", "/assets/%2eDS_Store", "/assets/../.env", "/./.env", "//.env", "/.ENV", "/.GIT/config", "/.env.", "/.env%20", "/.env::$DATA", "/.git/", "/.git"]) {
      const answer = await raw("GET", address);
      expect(answer.body, address).not.toContain(DOTTED);
      expect(answer.status, address).toBe(403);
      expect(answer.body, address).toBe(REFUSED);
    }
  });

  it("answer an address that cannot be read with a plain refusal, not with the framework's own words", async () => {
    for (const address of ["/%zz", "/%", "/%2", "/assets/%zzapp.js", "/%zzpi/tasks", "/api/%E0%A4%A", "/api/tasks/%"]) {
      const answer = await raw("GET", address);
      expect(answer.status, address).toBe(400);
      expect(answer.body, address).toBe(REFUSED); // it does not repeat the address, or say what the server is built with
      expect(answer.headers["x-content-type-options"], address).toBe("nosniff");
      expect(answer.headers["content-security-policy"], address).toContain("default-src 'self'");
    }
  });
});

describe("the protected routes, under other spellings of their address", () => {
  /** True when an answer is what the tasks route itself returns: a list with the owner's record in it. */
  const isTheRecord = (answer: Answer) => answer.body.includes(RECORD);
  /** Spellings the router reads as "/api/tasks": letters written as their codes. */
  const READ_AS_TASKS = ["/%61pi/tasks", "/a%70i/tasks", "/ap%69/tasks", "/%61%70%69/tasks", "/api/%74asks", "/api/task%73", "/%61pi/%74asks", "/%61%70%69/%74%61%73%6b%73"];

  it("the plain address needs a login, and works with one", async () => {
    const refused = await raw("GET", "/api/tasks");
    expect(refused.status).toBe(401);
    expect(refused.body).toBe(NOT_LOGGED_IN);
    const allowed = await raw("GET", "/api/tasks", { cookie });
    expect(allowed.status).toBe(200);
    expect(isTheRecord(allowed)).toBe(true);
    expect(allowed.headers["cache-control"]).toBe("no-store");
  });

  it("every spelling the router reads as a protected route asks for the login", async () => {
    for (const spelling of READ_AS_TASKS) {
      const anonymous = await raw("GET", spelling);
      expect(isTheRecord(anonymous), `GET ${spelling} without a login`).toBe(false);
      expect(anonymous.status, spelling).toBe(401);
      expect(anonymous.body, spelling).toBe(NOT_LOGGED_IN);
      // With the login it is the same route as ever, with the same care about caching.
      const withLogin = await raw("GET", spelling, { cookie });
      expect(withLogin.status, spelling).toBe(200);
      expect(isTheRecord(withLogin), spelling).toBe(true);
      expect(withLogin.headers["cache-control"], spelling).toBe("no-store");
    }
  });

  it("no other spelling of a protected address gives anything away either", async () => {
    const spellings = [
      "/%41PI/tasks",
      // Separators written as codes, doubled, or reversed.
      "/api%2ftasks",
      "/api%2Ftasks",
      "/%2fapi/tasks",
      "/%2Fapi%2Ftasks",
      "//api/tasks",
      "/api//tasks",
      "///api///tasks",
      "/api\\tasks",
      "\\api\\tasks",
      "/api%5ctasks",
      // Dot segments.
      "/./api/tasks",
      "/api/./tasks",
      "/x/../api/tasks",
      "/api/../api/tasks",
      "/assets/../api/tasks",
      "/%2e/api/tasks",
      "/x/%2e%2e/api/tasks",
      "/api/x/%2e%2e/tasks",
      "/api/x/../tasks",
      // Other spellings.
      "/API/tasks",
      "/Api/Tasks",
      "/api/tasks/",
      "/api/tasks;x=1",
      "/api;x=1/tasks",
      "/api/tasks%20",
      "/api/tasks%00",
      "/api/tasks%3f",
      "/api/tasks#top",
      "/%2561pi/tasks",
      "/%EF%BD%81pi/tasks",
      `http://${HOST}/api/tasks`,
      "http://other.example.net/api/tasks",
    ];
    for (const spelling of spellings) {
      const answer = await raw("GET", spelling);
      expect(isTheRecord(answer), `GET ${spelling} answered ${answer.status} with the owner's record`).toBe(false);
      // The login is asked for, or the address is not a protected route at all: then it is the screen, or a plain refusal.
      expect([SCREEN, REFUSED, NOT_LOGGED_IN, NOT_HTTP].some((expected) => answer.body.includes(expected)), `GET ${spelling} answered ${answer.status}: ${answer.body.slice(0, 80)}`).toBe(true);
      expect([200, 400, 401, 403], `GET ${spelling} answered ${answer.status}`).toContain(answer.status);
    }
  });

  it("no spelling lets a change through without a login, or from another site", async () => {
    const body = JSON.stringify({ title: "Planted under another spelling", area: "inbox" });
    const before = taskTitles(instance);
    for (const spelling of ["/api/tasks", ...READ_AS_TASKS]) {
      // No login at all.
      expect((await raw("POST", spelling, { body, origin: `http://${HOST}` })).status, `POST ${spelling} without a login`).toBe(401);
      // The owner's own login, sent along by a browser on another site's behalf.
      expect((await raw("POST", spelling, { body, cookie, origin: "http://other.example.net" })).status, `POST ${spelling} from another site`).toBe(403);
      // And without saying where it comes from.
      expect((await raw("POST", spelling, { body, cookie })).status, `POST ${spelling} without an origin`).toBe(403);
    }
    for (const spelling of ["//api/tasks", "/x/../api/tasks", "/API/tasks", "/api%2ftasks", "/api/tasks/", "/api\\tasks"]) {
      for (const options of [{ origin: `http://${HOST}` }, { cookie, origin: "http://other.example.net" }, { cookie, origin: `http://${HOST}` }]) {
        const answer = await raw("POST", spelling, { body, ...options });
        expect([400, 401, 403, 404], `POST ${spelling} answered ${answer.status}`).toContain(answer.status);
      }
    }
    expect(taskTitles(instance)).toEqual(before);

    // The owner's own page can still add a task, under the plain address and under another spelling of it.
    expect((await raw("POST", "/api/tasks", { body, cookie, origin: `http://${HOST}` })).status).toBe(201);
    expect((await raw("POST", "/%61pi/tasks", { body: JSON.stringify({ title: "A second one", area: "inbox" }), cookie, origin: `http://${HOST}` })).status).toBe(201);
    expect(taskTitles(instance)).toEqual(expect.arrayContaining(["Planted under another spelling", "A second one"]));
  });

  it("the routes that need no login stay the only ones", async () => {
    expect((await raw("GET", "/api/health")).status).toBe(200);
    expect((await raw("GET", "/%61pi/health")).status).toBe(200); // the same public route, spelled differently
    expect((await raw("GET", "/api/health/../tasks")).status).toBe(401);
    expect((await raw("GET", "/api/auth/session")).status).toBe(200);
    // Without a login, not even "there is nothing here".
    expect((await raw("GET", "/api/nothing-here")).status).toBe(401);
    expect((await raw("GET", "/%61pi/nothing-here")).status).toBe(401);
    // With one, an address that looks like the API and is not one says so, and is not answered with the screen.
    for (const address of ["/api/nothing-here", "/%61pi/nothing-here"]) {
      const answer = await raw("GET", address, { cookie });
      expect(answer.status, address).toBe(404);
      expect(answer.body, address).toBe(JSON.stringify({ error: "There is nothing at this address." }));
    }
  });

  it("everything the core serves outside the API is the screen's files", () => {
    // The login check is tied to the routes under /api. A route registered anywhere else would be public.
    expect(routes.filter((route) => !/^[A-Z]+ \/api\//.test(route)).sort()).toEqual(["GET /*", "HEAD /*"]);
    expect(routes.filter((route) => route.includes("/api/")).length).toBeGreaterThan(20);
  });

  it("decides by the route the router chose, then by the address as written and as decoded", () => {
    const ask = (url: string, route?: string) => isApiRequest({ url, routeOptions: { url: route } } as Parameters<typeof isApiRequest>[0]);
    expect(ask("/%61pi/tasks", "/api/tasks")).toBe(true); // the router's reading counts, whatever the text looks like
    expect(ask("/anything", "/api/tasks/:id")).toBe(true);
    expect(ask("/api/x/../tasks", "/*")).toBe(true); // looks like the API: treated as the API
    expect(ask("/api/nothing?x=1")).toBe(true);
    expect(ask("/%61pi/nothing")).toBe(true);
    expect(ask("/api%2ftasks", "/*")).toBe(true);
    expect(ask("/assets/app.js", "/*")).toBe(false);
    expect(ask("/", "/*")).toBe(false);
    expect(ask("/apiary")).toBe(false);
    expect(ask("/sales?next=/api/tasks", "/*")).toBe(false); // what follows the question mark is not the address
    expect(ask("/%zzpi/tasks")).toBe(false); // unreadable: the router refuses it before any route is chosen
    expect(ask("/api/tasks/%zz")).toBe(true); // but an address that starts as the API is the API, readable to the end or not
  });
});
