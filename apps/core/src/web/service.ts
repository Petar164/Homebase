import type { Config } from "../config.ts";
import { decodeBody, extractPage, extractText, type Page } from "./extract.ts";
import { fetchPage, Limiter, type Opener, WebError } from "./http.ts";
import { type Recency, resolveSearch, type SearchHit } from "./search.ts";

// HELIOS's access to the public web: one place that knows whether it is
// switched on, which search service is set up, and the limits every request
// is held to. The tools in ai/webTools.ts decide what to ask for and how
// much of the answer a model sees; nothing else in the core reaches the
// internet through here.

export type WebStatus = {
  /** The owner's switch. */
  enabled: boolean;
  /** True when a search could run right now: switched on, and a search service has its key. */
  ready: boolean;
  /** The search service in use, by name, or null when none is set up. */
  service: string | null;
  confirmEvery: boolean;
  /** Why it is not ready, in words for the owner. Null when it is. */
  problem: string | null;
};

export type WebDeps = {
  /** The live settings: read on every use, so a change on screen takes effect at once. */
  settings: () => Config["web"];
  env?: NodeJS.ProcessEnv;
  /** For the search service. Tests pass one that answers from memory. */
  fetch?: typeof fetch;
  /** For pages. Tests pass one that answers from memory. */
  opener?: Opener;
  now?: () => Date;
};

export class WebAccess {
  private readonly settings: () => Config["web"];
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetcher: typeof fetch | undefined;
  private readonly opener: Opener | undefined;
  private readonly now: () => Date;
  private limiter: { limit: number; pages: Limiter } | null = null;

  constructor(deps: WebDeps) {
    this.settings = deps.settings;
    this.env = deps.env ?? process.env;
    this.fetcher = deps.fetch;
    this.opener = deps.opener;
    this.now = deps.now ?? (() => new Date());
  }

  get config(): Config["web"] {
    return this.settings();
  }

  status(): WebStatus {
    const settings = this.settings();
    const setup = resolveSearch(settings.search, this.env, this.fetcher);
    const problem = !settings.enabled ? "web access is switched off" : setup.problem;
    return { enabled: settings.enabled, ready: settings.enabled && setup.provider !== null, service: setup.provider?.name ?? null, confirmEvery: settings.confirmEvery, problem };
  }

  private requireEnabled(): Config["web"] {
    const settings = this.settings();
    if (!settings.enabled) throw new WebError("disabled", "web access is switched off on this machine");
    return settings;
  }

  /** One live search. Throws a WebError when it could not be done; an empty list means the service found nothing. */
  async search(query: string, recency?: Recency): Promise<{ service: string; hits: SearchHit[] }> {
    const settings = this.requireEnabled();
    const setup = resolveSearch(settings.search, this.env, this.fetcher);
    if (!setup.provider) throw new WebError("unavailable", setup.problem);
    const hits = await setup.provider.search({
      query,
      recency,
      maxResults: settings.search.maxResults,
      snippetChars: settings.search.snippetChars,
      signal: AbortSignal.timeout(settings.search.timeoutMs),
      now: this.now(),
    });
    return { service: setup.provider.name, hits };
  }

  /** Fetches one page and turns it into readable text. Throws a WebError when that was not possible. */
  async read(url: URL): Promise<{ url: URL; page: Page; truncated: boolean }> {
    const settings = this.requireEnabled();
    const limit = settings.limits.concurrent;
    if (this.limiter?.limit !== limit) this.limiter = { limit, pages: new Limiter(limit) };
    return this.limiter.pages.run(async () => {
      const fetched = await fetchPage(url, { timeoutMs: settings.page.timeoutMs, maxBytes: settings.page.maxBytes, maxRedirects: settings.page.maxRedirects }, { opener: this.opener });
      const text = decodeBody(fetched.body, fetched.charset);
      // A page sent without a type is HTML if it looks like HTML.
      const html = fetched.contentType === "text/html" || fetched.contentType === "application/xhtml+xml" ? !/^\s*[^<\s]/.test(text.slice(0, 200)) || /<html|<body|<p[\s>]|<div[\s>]/i.test(text.slice(0, 4000)) : false;
      const page = html ? extractPage(text, fetched.url, this.now()) : extractText(text, fetched.url);
      if (page.blocks.length === 0) throw new WebError("unsupported", "that page has no text to read (it may only work with JavaScript, which is never run here)");
      return { url: fetched.url, page, truncated: fetched.truncated };
    });
  }
}
