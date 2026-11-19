import { z } from "zod";
import type { Config } from "../config.ts";
import { plainText, readDate } from "./extract.ts";
import { WebError } from "./http.ts";
import { cleanText } from "./sanitize.ts";
import { checkWebUrl, siteOf, urlKey } from "./url.ts";

// Searching the public web through a search service's documented API.
//
// Two services are supported behind one small interface, so that a change
// of terms at one of them is a change of one setting here:
//
//   Brave Search   its own index; states that queries are not shared or
//                  used for training. A card is asked for at sign-up.
//   Tavily         made for assistants; a free monthly allowance without a
//                  card. Its privacy terms are weaker than Brave's.
//
// The key comes from the environment (BRAVE_SEARCH_API_KEY or
// TAVILY_API_KEY), never from config.json, the database or this code. It is
// sent to that service only, and it never appears in an error or a log.
//
// What a service answers is checked like any other outside input: the shape,
// every address in it, and the text (cleaned, shortened). A result is never
// invented here: no results means an empty list, and a date is passed on
// only when the service gave one that can be read.

export type Recency = "day" | "week" | "month" | "year";

export type SearchHit = {
  title: string;
  url: URL;
  site: string;
  /** The service's own summary of the page, as plain text. */
  snippet: string;
  /** YYYY-MM-DD when the service gave a date, otherwise null. */
  published: string | null;
};

export type SearchRequest = { query: string; recency?: Recency; maxResults: number; snippetChars: number; signal: AbortSignal; now: Date };

export interface SearchProvider {
  readonly id: "brave" | "tavily";
  /** The name shown to the owner, for example in an approval. */
  readonly name: string;
  search(request: SearchRequest): Promise<SearchHit[]>;
}

type Settings = Config["web"]["search"];
type Fetch = typeof fetch;

export const SEARCH_KEYS = { brave: "BRAVE_SEARCH_API_KEY", tavily: "TAVILY_API_KEY" } as const;
const SEARCH_NAMES = { brave: "Brave Search", tavily: "Tavily" } as const;
const DEFAULT_BASE = { brave: "https://api.search.brave.com", tavily: "https://api.tavily.com" } as const;

function serviceProblem(status: number): WebError {
  if (status === 401 || status === 403) return new WebError("http", `the search service did not accept the key (status ${status})`);
  if (status === 429) return new WebError("http", "the search service's limit for now is used up (status 429)");
  if (status === 432 || status === 433 || status === 402) return new WebError("http", `the search service's allowance is used up (status ${status})`);
  if (status === 400 || status === 422) return new WebError("http", `the search service did not accept the request (status ${status})`);
  if (status >= 500) return new WebError("http", `the search service had a problem of its own (status ${status})`);
  return new WebError("http", `the search service answered with status ${status}`);
}

/** One request to a search service, with every failure turned into a WebError that quotes nothing. */
async function ask(fetcher: Fetch, url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal, redirect: "error" });
  } catch {
    // Whatever the error says, it may quote the address, and the address holds the query.
    throw signal.aborted ? new WebError("timeout", "the search service did not answer in time") : new WebError("network", "the search service could not be reached");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw serviceProblem(response.status);
  }
  try {
    return await response.json();
  } catch {
    throw signal.aborted ? new WebError("timeout", "the search service did not answer in time") : new WebError("malformed", "the search service answered with something that could not be read");
  }
}

/** Checks, cleans and de-duplicates what a service returned. Results that cannot be opened safely are dropped. */
function tidy(raw: { title?: string; url: string; text?: string; date?: string | null; siteName?: string }[], request: SearchRequest): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const checked = checkWebUrl(item.url);
    if (!checked.ok || seen.has(urlKey(checked.url))) continue;
    seen.add(urlKey(checked.url));
    const title = plainText(item.title ?? "", 160) || siteOf(checked.url);
    hits.push({ title, url: checked.url, site: siteOf(checked.url), snippet: plainText(item.text ?? "", request.snippetChars), published: readDate(item.date, request.now) });
    if (hits.length >= request.maxResults) break;
  }
  return hits;
}

/** A query no longer than the services accept. */
function fit(query: string): string {
  return cleanText(query, 380).split(" ").slice(0, 48).join(" ");
}

const braveAnswer = z.looseObject({
  web: z
    .looseObject({
      results: z.array(
        z.looseObject({
          title: z.string().optional(),
          url: z.string(),
          description: z.string().optional(),
          page_age: z.string().nullish(),
          age: z.string().nullish(),
        }),
      ),
    })
    .optional(),
});

const tavilyAnswer = z.looseObject({
  results: z.array(z.looseObject({ title: z.string().nullish(), url: z.string(), content: z.string().nullish(), published_date: z.string().nullish() })),
});

/**
 * The name the owner is shown. When the settings point the service at
 * another address (a proxy, a stand-in for a test), the name says so: "who
 * it goes to" has to be true.
 */
function shownName(id: "brave" | "tavily", settings: Settings): string {
  if (!settings.baseUrl) return SEARCH_NAMES[id];
  return `${SEARCH_NAMES[id]} by way of ${new URL(settings.baseUrl).host}`;
}

function malformed(): WebError {
  return new WebError("malformed", "the search service answered with something that could not be read");
}

function brave(settings: Settings, key: string, fetcher: Fetch): SearchProvider {
  const freshness: Record<Recency, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
  return {
    id: "brave",
    name: shownName("brave", settings),
    async search(request) {
      const address = new URL("/res/v1/web/search", settings.baseUrl || DEFAULT_BASE.brave);
      address.searchParams.set("q", fit(request.query));
      address.searchParams.set("count", String(Math.min(20, request.maxResults + 3))); // a few spare, for results that are dropped
      address.searchParams.set("safesearch", settings.safeSearch);
      if (request.recency) address.searchParams.set("freshness", freshness[request.recency]);
      if (settings.country) address.searchParams.set("country", settings.country.toUpperCase());
      const data = braveAnswer.safeParse(await ask(fetcher, address.href, { headers: { Accept: "application/json", "X-Subscription-Token": key } }, request.signal));
      if (!data.success) throw malformed();
      // When nothing matches, the service leaves the "web" part out.
      return tidy((data.data.web?.results ?? []).map((item) => ({ title: item.title, url: item.url, text: item.description, date: item.page_age ?? item.age })), request);
    },
  };
}

function tavily(settings: Settings, key: string, fetcher: Fetch): SearchProvider {
  return {
    id: "tavily",
    name: shownName("tavily", settings),
    async search(request) {
      const address = new URL("/search", settings.baseUrl || DEFAULT_BASE.tavily);
      const body = {
        query: fit(request.query),
        search_depth: "basic", // one credit per search
        topic: "general",
        max_results: Math.min(20, request.maxResults + 3),
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_published_date: true,
        safe_search: settings.safeSearch !== "off",
        ...(request.recency ? { time_range: request.recency } : {}),
      };
      const data = tavilyAnswer.safeParse(
        await ask(fetcher, address.href, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) }, request.signal),
      );
      if (!data.success) throw malformed();
      return tidy(data.data.results.map((item) => ({ title: item.title ?? undefined, url: item.url, text: item.content ?? undefined, date: item.published_date })), request);
    },
  };
}

export type SearchSetup = { provider: SearchProvider; problem: null } | { provider: null; problem: string };

/**
 * Which search service is used, from the settings and the keys present.
 * "auto" takes the service that has a key, Brave first.
 */
export function resolveSearch(settings: Settings, env: NodeJS.ProcessEnv, fetcher: Fetch = fetch): SearchSetup {
  const keyOf = (id: "brave" | "tavily") => (env[SEARCH_KEYS[id]] ?? "").trim();
  const build = { brave, tavily };
  const wanted = settings.provider === "auto" ? (["brave", "tavily"] as const).find((id) => keyOf(id)) : settings.provider;
  if (!wanted) return { provider: null, problem: `no search service is set up (${SEARCH_KEYS.brave} or ${SEARCH_KEYS.tavily} is missing from the environment)` };
  if (!keyOf(wanted)) return { provider: null, problem: `the key for ${SEARCH_NAMES[wanted]} is missing (${SEARCH_KEYS[wanted]} in the environment)` };
  return { provider: build[wanted](settings, keyOf(wanted), fetcher), problem: null };
}
