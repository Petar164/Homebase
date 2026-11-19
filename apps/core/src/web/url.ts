import { hostProblem } from "./address.ts";

// Reading an address before anything is done with it. Only "https" on the
// standard port, a public-looking host, and no login details in the address.

export type WebUrl = { ok: true; url: URL } | { ok: false; reason: string };

/** The longest address that is accepted. Longer ones are refused rather than cut, which would change where they lead. */
export const MAX_URL_LENGTH = 2000;

/**
 * Checks an address and returns it in a normal form: https, no fragment.
 * What its name resolves to is not checked here; that happens when the
 * connection is made.
 */
export function checkWebUrl(raw: string): WebUrl {
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH) return { ok: false, reason: "that is not a usable web address" };
  // Control characters and spaces have no place in an address, and a
  // backslash is read as a slash by some programs and not by others.
  if (/[\u0000-\x20\u007f\\]/.test(text)) return { ok: false, reason: "that is not a usable web address" };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "that is not a usable web address" };
  }
  // Plain http is never used. An http address is tried over https instead.
  if (url.protocol === "http:" && (url.port === "" || url.port === "80")) {
    url.protocol = "https:";
    url.port = "";
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https web addresses can be opened" };
  if (url.username || url.password) return { ok: false, reason: "addresses that carry a login are not opened" };
  if (url.port !== "" && url.port !== "443") return { ok: false, reason: "only the standard https port is used" };
  const problem = hostProblem(url.hostname);
  if (problem) return { ok: false, reason: `that address is ${problem}, not a public website` };
  url.hash = "";
  return { ok: true, url };
}

/** Parts of an address that track a visit and say nothing about the page. */
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref_url)$/i;

/**
 * One spelling for addresses that lead to the same page, used to recognise
 * a page that was already seen. Never used to fetch.
 */
export function urlKey(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const kept = [...url.searchParams.entries()].filter(([name]) => !TRACKING.test(name)).sort(([a], [b]) => a.localeCompare(b));
  const query = kept.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&");
  return `${host}${path}${query ? `?${query}` : ""}`;
}

/** The site name shown next to a source: the host without "www.". */
export function siteOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/** Web addresses written in a piece of text, in their normal form. Used on the owner's own words only. */
export function urlsIn(text: string): URL[] {
  const found: URL[] = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/gi)) {
    // Punctuation that ends the sentence is not part of the address.
    const checked = checkWebUrl(match[0].replace(/[).,;:!?\]]+$/, ""));
    if (checked.ok) found.push(checked.url);
  }
  return found;
}
