import dns from "node:dns";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { addressProblem } from "./address.ts";
import { checkWebUrl, urlKey } from "./url.ts";

// Fetching one public web page, carefully.
//
//   - https only, on the standard port; a redirect is a new address and gets
//     every check again, a limited number of times
//   - the name is resolved once, every address it resolves to must be a
//     public one, and the connection is made to exactly those addresses.
//     A name that answers "public" when checked and "this machine" when
//     used ("DNS rebinding") therefore gets nowhere
//   - a time limit for the whole fetch and a size limit for the body
//   - nothing is sent but the request itself: no cookies, no referrer, no
//     login. Cookies a site sets are ignored and never kept
//   - the body is only ever read as text. No script in it is run

export type WebErrorKind =
  | "disabled" // web access is switched off
  | "unavailable" // no search service is set up
  | "blocked" // the address is not a public website
  | "invalid" // the request itself was not acceptable
  | "refused" // a rule about what may be sent out said no
  | "limit" // enough requests for one question, or no room left
  | "timeout"
  | "network"
  | "http" // the site or service answered with an error
  | "unsupported" // not something that can be read as a page
  | "malformed"; // the answer could not be understood

/** A web request that did not work. The message is written for the owner and names no secret. */
export class WebError extends Error {
  readonly kind: WebErrorKind;
  constructor(kind: WebErrorKind, message: string) {
    super(message);
    this.name = "WebError";
    this.kind = kind;
  }
}

export type Resolved = { address: string; family: number };
/** Turns a host name into addresses. The real one asks the system; tests supply their own. */
export type Resolver = (hostname: string) => Promise<Resolved[]>;

export const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * A name lookup for a connection that only ever hands back public
 * addresses. If any address the name resolves to is not public, the whole
 * lookup fails: a name that mixes public and private answers is not one to
 * reason about.
 */
export function guardedLookup(resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        const problem = found.length === 0 ? "nothing" : found.map((entry) => addressProblem(entry.address)).find((reason) => reason !== null);
        if (found.length === 0) return callback(new WebError("network", "that site's name could not be found"), "", 0);
        if (problem) return callback(new WebError("blocked", `that site's name leads to ${problem}, not to a public website`), "", 0);
        if (options.all) return callback(null, found);
        const first = found[0] as Resolved;
        return callback(null, first.address, first.family);
      },
      () => callback(new WebError("network", "that site's name could not be found"), "", 0),
    );
  };
}

/** One request and its answer, before any redirect is followed. */
export type Hop = { status: number; headers: Record<string, string | string[] | undefined>; body: Readable };
export type Opener = (url: URL, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Hop>;

/** The real way out: Node's https, with the guarded lookup. */
export function httpsOpener(options: { resolve?: Resolver } = {}): Opener {
  const lookup = guardedLookup(options.resolve);
  return (url, init) =>
    new Promise<Hop>((resolve, reject) => {
      const request = https.request(
        {
          protocol: "https:",
          hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: init.headers,
          signal: init.signal,
          lookup,
          // A connection of its own for every request: nothing is reused across sites.
          agent: false,
        },
        (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }),
      );
      // Checked once more on the connection itself: where it really went.
      request.on("socket", (socket) => {
        socket.once("connect", () => {
          const problem = socket.remoteAddress ? addressProblem(socket.remoteAddress) : null;
          if (problem) request.destroy(new WebError("blocked", `that site's name leads to ${problem}, not to a public website`));
        });
      });
      request.on("error", (error) => reject(error));
      request.end();
    });
}

export type FetchLimits = { timeoutMs: number; maxBytes: number; maxRedirects: number };
export type Fetched = {
  /** Where the content finally came from, after redirects. */
  url: URL;
  contentType: string;
  charset: string | null;
  body: Buffer;
  /** True when the page was longer than the size limit and only its beginning was read. */
  truncated: boolean;
  redirects: number;
};

const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; HomeBaseReader/1.0; reads one page at a time for one person)",
  Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
  "Accept-Language": "en;q=0.9,*;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
};

const READABLE = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown"]);
const KNOWN_KINDS: [RegExp, string][] = [
  [/^application\/pdf$/, "a PDF"],
  [/^image\//, "an image"],
  [/^video\//, "a video"],
  [/^audio\//, "a sound file"],
  [/^application\/(zip|gzip|x-tar|x-7z-compressed|x-rar-compressed|octet-stream)$/, "a file to download"],
  [/^application\/(json|[a-z.+-]*\+json)$/, "raw data"],
  [/(msword|officedocument|ms-excel|ms-powerpoint|opendocument)/, "an office document"],
];

function header(hop: Hop, name: string): string {
  const value = hop.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function httpProblem(status: number): string {
  if (status === 401 || status === 403) return `that site refused the request (status ${status})`;
  if (status === 404 || status === 410) return `that page does not exist (status ${status})`;
  if (status === 429) return "that site is limiting how often it can be read (status 429)";
  if (status >= 500) return `that site had a problem of its own (status ${status})`;
  return `that site answered with status ${status}`;
}

/** Translates whatever went wrong into a WebError, without passing on text that could quote the request. */
function asWebError(error: unknown, timedOut: boolean): WebError {
  if (error instanceof WebError) return error;
  if (timedOut) return new WebError("timeout", "that site did not answer in time");
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new WebError("network", "that site's name could not be found");
  if (/CERT|SSL|TLS|SELF_SIGNED|ALTNAME/i.test(code)) return new WebError("network", "that site's security certificate was not accepted");
  if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" || code.startsWith("ERR_BROTLI")) return new WebError("malformed", "that page could not be unpacked");
  return new WebError("network", "that site could not be reached");
}

/** Reads a body up to `maxBytes` of unpacked content. */
async function readBody(hop: Hop, maxBytes: number, signal: AbortSignal): Promise<{ body: Buffer; truncated: boolean }> {
  const encoding = header(hop, "content-encoding").trim().toLowerCase();
  let stream: Readable = hop.body;
  if (encoding === "gzip" || encoding === "x-gzip") stream = hop.body.pipe(zlib.createGunzip());
  else if (encoding === "deflate") stream = hop.body.pipe(zlib.createInflate());
  else if (encoding === "br") stream = hop.body.pipe(zlib.createBrotliDecompress());
  else if (encoding && encoding !== "identity") throw new WebError("unsupported", "that page is packed in a way that cannot be read here");

  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const stop = () => {
    stream.destroy();
    hop.body.destroy();
  };
  // A failure of the packed stream has to reach the loop below, which reads the unpacked one.
  if (stream !== hop.body) hop.body.once("error", (error) => stream.destroy(error));
  signal.addEventListener("abort", stop, { once: true });
  try {
    for await (const chunk of stream) {
      const piece = chunk as Buffer;
      if (size + piece.length > maxBytes) {
        // Only the beginning of an over-long page is kept. Nothing more is downloaded.
        chunks.push(piece.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(piece);
      size += piece.length;
    }
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
  if (signal.aborted) throw new WebError("timeout", "that site did not answer in time");
  return { body: Buffer.concat(chunks), truncated };
}

/**
 * Fetches a page, following redirects by hand so that every address on the
 * way is checked like the first one.
 */
export async function fetchPage(start: URL, limits: FetchLimits, options: { opener?: Opener; signal?: AbortSignal } = {}): Promise<Fetched> {
  const opener = options.opener ?? httpsOpener();
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const seen = new Set<string>();
  let url = start;

  try {
    for (let redirects = 0; ; redirects++) {
      // The first address was checked by the caller; checking it again here
      // means no path into this function can skip the check.
      const checked = checkWebUrl(url.href);
      if (!checked.ok) throw new WebError("blocked", checked.reason);
      url = checked.url;
      if (seen.has(urlKey(url))) throw new WebError("network", "that address keeps redirecting in a circle");
      seen.add(urlKey(url));

      const hop = await opener(url, { headers: REQUEST_HEADERS, signal });
      if (hop.status >= 300 && hop.status < 400 && hop.status !== 304) {
        hop.body.destroy();
        const location = header(hop, "location");
        if (!location) throw new WebError("network", "that address redirects to nowhere");
        if (redirects >= limits.maxRedirects) throw new WebError("network", `that address redirects more than ${limits.maxRedirects} times`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new WebError("network", "that address redirects to something that is not an address");
        }
        // A redirect to plain http is not followed by "upgrading" it: the site asked for something this reader does not do.
        if (next.protocol !== "https:") throw new WebError("blocked", "that address redirects away from https");
        url = next;
        continue;
      }
      if (hop.status < 200 || hop.status >= 300) {
        hop.body.destroy();
        throw new WebError("http", httpProblem(hop.status));
      }

      const [type = "", ...parameters] = header(hop, "content-type").split(";").map((part) => part.trim());
      const contentType = type.toLowerCase();
      if (contentType && !READABLE.has(contentType)) {
        hop.body.destroy();
        const kind = KNOWN_KINDS.find(([pattern]) => pattern.test(contentType))?.[1];
        throw new WebError("unsupported", kind ? `that address is ${kind}, not a page of text` : "that address is not a page of text");
      }
      const charset = parameters.map((parameter) => /^charset\s*=\s*"?([\w.:-]+)"?$/i.exec(parameter)?.[1]).find(Boolean) ?? null;
      const { body, truncated } = await readBody(hop, limits.maxBytes, signal);
      return { url, contentType: contentType || "text/html", charset, body, truncated, redirects };
    }
  } catch (error) {
    throw asWebError(error, deadline.aborted);
  }
}

/** Lets at most `limit` pieces of work run at once; the rest wait their turn. */
export class Limiter {
  private readonly limit: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
