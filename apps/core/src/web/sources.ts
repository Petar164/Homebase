import type { WebSource } from "@homebase/shared";
import { urlKey } from "./url.ts";

/**
 * The numbered list of web pages a conversation has seen. A page keeps its
 * number for the whole conversation, so "[3]" in an answer, "source 3" in a
 * model's request and the third link on screen are always the same page.
 *
 * The list is rebuilt from the stored transcript each time: a model can ask
 * for a number, but it cannot add an entry.
 */
export class SourceBook {
  private readonly byNumber = new Map<number, WebSource>();
  private readonly byKey = new Map<string, WebSource>();

  constructor(known: WebSource[] = []) {
    for (const source of known) this.restore(source);
  }

  private keyOf(url: string): string {
    try {
      return urlKey(new URL(url));
    } catch {
      return url;
    }
  }

  /** Puts back a source that was stored earlier. A page that was later opened stays "page". */
  restore(source: WebSource): void {
    const existing = this.byNumber.get(source.n);
    const merged: WebSource = existing ? { ...existing, kind: existing.kind === "page" || source.kind === "page" ? "page" : "result", date: existing.date ?? source.date } : { ...source };
    this.byNumber.set(merged.n, merged);
    this.byKey.set(this.keyOf(merged.url), merged);
  }

  /** The entry for this page: the one it already has, or a new one with the next number. */
  note(url: URL, details: { title: string; site: string; kind: "result" | "page"; date: string | null }): WebSource {
    const existing = this.byKey.get(urlKey(url));
    if (existing) {
      const updated: WebSource = { ...existing, kind: existing.kind === "page" || details.kind === "page" ? "page" : "result", date: existing.date ?? details.date };
      this.restore(updated);
      return updated;
    }
    const created: WebSource = { n: Math.max(0, ...this.byNumber.keys()) + 1, title: details.title, url: url.href, site: details.site, kind: details.kind, date: details.date };
    this.restore(created);
    return created;
  }

  get(n: number): WebSource | undefined {
    return this.byNumber.get(n);
  }

  find(url: URL): WebSource | undefined {
    return this.byKey.get(urlKey(url));
  }

  all(): WebSource[] {
    return [...this.byNumber.values()].sort((a, b) => a.n - b.n);
  }
}
