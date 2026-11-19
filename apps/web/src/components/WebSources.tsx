import type { WebActivity, WebSource, WebUse } from "@homebase/shared";
import type { ReactNode } from "react";

// How an answer that used the live web looks on screen: its source numbers
// become links, and under it stand the pages it came from, or what went
// wrong. Every link here comes from the core's own record of what its web
// tools returned. An address a model merely wrote stays plain text.

const linkProps = { target: "_blank", rel: "noopener noreferrer" } as const;

/** An answer's text, with each "[n]" that names a real source turned into a link to it. */
export function Cited({ text, sources }: { text: string; sources: WebSource[] | undefined }) {
  if (!sources?.length) return <>{text}</>;
  const byNumber = new Map(sources.map((source) => [source.n, source]));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,6}(?:\s*,\s*\d{1,6})*)\]/g)) {
    const numbers = (match[1] ?? "").split(",").map((part) => Number(part.trim()));
    if (!numbers.some((n) => byNumber.has(n))) continue;
    parts.push(text.slice(last, match.index));
    for (const n of numbers) {
      const source = byNumber.get(n);
      parts.push(
        source ? (
          <a key={`${match.index}-${n}`} href={source.url} {...linkProps} aria-label={`Source ${n}: ${source.title}, ${source.site}`} title={`${source.title} (${source.site})`} className="mx-0.5 align-super text-[0.55em] font-normal text-salmon underline-offset-2 hover:underline focus-visible:underline">
            [{n}]
          </a>
        ) : (
          <span key={`${match.index}-${n}`}>[{n}]</span>
        ),
      );
    }
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : word.endsWith("ch") ? "es" : "s"}`;

/**
 * What stands under an answer that used the web. `open` shows the list of
 * sources; without it only the one-line summary is shown, so that older
 * answers on screen stay short.
 */
export function WebNote({ web, open }: { web: WebUse; open: boolean }) {
  const done = [web.searches > 0 ? count(web.searches, "search") : "", web.pages > 0 ? `${count(web.pages, "page")} read` : ""].filter(Boolean).join(" · ");
  return (
    <div className="mt-1.5 space-y-1">
      <p className="label">
        {web.live ? (
          <>
            <span className="text-salmon">Live web</span>
            {done && ` · ${done}`}
          </>
        ) : (
          <span className="text-salmon">The web was not reached</span>
        )}
      </p>
      {open
        ? web.failures.map((failure) => (
            <p key={failure} role="status" className="text-sm text-salmon/90">
              {failure}
            </p>
          ))
        : web.live && web.failures.length > 0 && <p className="text-xs text-salmon/90">{count(web.failures.length, "request")} did not work</p>}
      {open && web.live && web.sources.length === 0 && web.failures.length === 0 && <p className="text-sm text-mute">The search found nothing.</p>}
      {open && web.sources.length > 0 && (
        <ol aria-label="Sources" className="space-y-0.5 text-sm text-mute">
          {web.sources.slice(0, 6).map((source) => (
            <li key={source.n} className="truncate">
              <a href={source.url} {...linkProps} className="text-soft underline-offset-2 hover:text-bone hover:underline focus-visible:text-bone focus-visible:underline">
                <span className="mr-1.5 text-salmon tabular-nums">[{source.n}]</span>
                {source.title}
              </a>
              <span className="ml-2">
                {source.site}
                {source.date && ` · ${source.date}`}
                {source.kind === "page" && " · read"}
              </span>
            </li>
          ))}
          {web.sources.length > 6 && <li>and {web.sources.length - 6} more</li>}
        </ol>
      )}
      {!open && web.sources.length > 0 && <p className="text-xs text-mute">{count(web.sources.length, "source")}</p>}
    </div>
  );
}

/** One line of feedback while a web request is under way, waiting for a yes, or after it failed. */
export function ActivityLine({ activity }: { activity: WebActivity }) {
  const tone = activity.status === "failed" ? "text-salmon/90" : activity.status === "running" ? "text-soft" : "text-mute";
  const state = { running: "…", done: activity.detail ? `: ${activity.detail}` : ": done", failed: `: ${activity.detail ?? "it did not work"}`, waiting: ": waiting for your yes" }[activity.status];
  return (
    <p role="status" className={`truncate text-sm ${tone}`}>
      {activity.label}
      {state}
    </p>
  );
}
