import { type DefaultTreeAdapterTypes as Tree, parse, parseFragment } from "parse5";
import { cleanText } from "./sanitize.ts";
import { siteOf } from "./url.ts";

// From a page's HTML to the text a person would read on it.
//
// The page is parsed the way a browser parses it, but nothing in it runs:
// no script, no style sheet, no image, no frame, no further request. What
// comes out is plain text in reading order. Left out on purpose: scripts
// and styles, navigation, forms, anything marked hidden (a common place to
// hide instructions for an assistant), comments, image descriptions, and
// the addresses of links. HELIOS cannot follow a link it was never shown.

export type Page = {
  title: string;
  description: string;
  /** The site's own name for itself, or its host name. */
  site: string;
  /** The date the page says it was published, as YYYY-MM-DD. Null when the page does not say. */
  published: string | null;
  language: string | null;
  /** The readable text, one block per paragraph. Headings start with "# ", list items with "- ". */
  blocks: string[];
};

type Element = Tree.Element;
type AnyNode = Tree.Node;

const isElement = (node: AnyNode): node is Element => "tagName" in node;
const isText = (node: AnyNode): node is Tree.TextNode => node.nodeName === "#text";
const attribute = (element: Element, name: string): string => element.attrs.find((entry) => entry.name === name)?.value ?? "";
const children = (node: AnyNode): Tree.ChildNode[] => ("childNodes" in node ? node.childNodes : []);

/** Never text for a reader. */
const SKIPPED_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "frame", "frameset", "object", "embed", "applet",
  "video", "audio", "picture", "source", "track", "map", "area", "img", "form", "button", "select", "option", "optgroup", "datalist",
  "input", "textarea", "label", "fieldset", "dialog", "menu", "nav", "aside", "footer", "head", "link", "meta", "base", "title",
]);
const SKIPPED_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist", "form"]);
/** Parts of a class or id that mark page furniture, or text meant not to be seen. */
const CLUTTER = new Set([
  "nav", "navbar", "navigation", "menu", "sidebar", "sidenav", "footer", "breadcrumb", "breadcrumbs", "cookie", "cookies", "consent", "gdpr",
  "advert", "advertisement", "ad", "ads", "sponsored", "promo", "popup", "modal", "overlay", "share", "sharing", "social", "related", "recommended",
  "newsletter", "subscribe", "subscription", "paywall", "comments", "disqus", "pagination", "pager", "toolbar", "skip", "skiplink",
  "hidden", "invisible", "offscreen", "sr", "visuallyhidden",
]);
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|$)|(?:left|top|text-indent)\s*:\s*-\d{3,})/i;

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "body", "ul", "ol", "li", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
  "table", "thead", "tbody", "tfoot", "tr", "caption", "figure", "figcaption", "address", "details", "summary", "header", "hgroup", "center", "hr", "br",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Most blocks kept from one page, and the longest one block may be. Bounds the work a hostile page can cause. */
const MAX_BLOCKS = 1500;
const MAX_BLOCK_CHARS = 3000;

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[\s_-]+/).filter(Boolean);
}

/** True for an element whose content is not shown to a reader, or is page furniture. */
function isSkipped(element: Element, insideContent: boolean): boolean {
  const tag = element.tagName;
  if (SKIPPED_TAGS.has(tag)) return true;
  // A page's own header is its logo and menu; an article's header is its headline.
  if (tag === "header" && !insideContent) return true;
  if (element.attrs.some((entry) => entry.name === "hidden") && attribute(element, "hidden") !== "until-found") return true;
  if (attribute(element, "aria-hidden").toLowerCase() === "true") return true;
  if (SKIPPED_ROLES.has(attribute(element, "role").toLowerCase())) return true;
  const style = attribute(element, "style");
  if (style && HIDDEN_STYLE.test(style)) return true;
  // The page's main parts are kept whatever they are called.
  if (tag === "body" || tag === "main" || tag === "article") return false;
  const names = [...tokens(attribute(element, "class")), ...tokens(attribute(element, "id"))];
  return names.some((name) => CLUTTER.has(name));
}

const isContentRoot = (element: Element): boolean =>
  element.tagName === "article" || element.tagName === "main" || attribute(element, "role").toLowerCase() === "main" || attribute(element, "itemprop").toLowerCase() === "articlebody";

/** Finds the first element with this tag, without recursion (a page can be nested very deep). */
function findElement(root: AnyNode, tag: string): Element | null {
  const stack: AnyNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AnyNode;
    if (isElement(node) && node.tagName === tag) return node;
    const kids = children(node);
    for (let index = kids.length - 1; index >= 0; index--) stack.push(kids[index] as AnyNode);
  }
  return null;
}

function textOf(root: AnyNode, limit = 2000): string {
  let out = "";
  const stack: AnyNode[] = [root];
  while (stack.length > 0 && out.length < limit) {
    const node = stack.pop() as AnyNode;
    if (isText(node)) out += node.value;
    const kids = children(node);
    for (let index = kids.length - 1; index >= 0; index--) stack.push(kids[index] as AnyNode);
  }
  return out;
}

/** A date a page states, as YYYY-MM-DD, or null. Nothing is guessed: an unreadable or impossible date is no date. */
export function readDate(value: unknown, now: Date = new Date()): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 80) return null;
  const time = Date.parse(value.trim());
  if (!Number.isFinite(time)) return null;
  if (time < Date.UTC(1990, 0, 1) || time > now.getTime() + 2 * 86_400_000) return null;
  // A value that already starts with a calendar date keeps it: no time zone can move it to another day.
  const written = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return written ? `${written[1]}-${written[2]}-${written[3]}` : new Date(time).toISOString().slice(0, 10);
}

/** Looks for "datePublished" in the structured data some pages carry. */
function publishedInStructuredData(json: string, now: Date): string | null {
  if (json.length > 200_000) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const queue: unknown[] = [data];
  for (let looked = 0; queue.length > 0 && looked < 200; looked++) {
    const item = queue.shift();
    if (Array.isArray(item)) queue.push(...item.slice(0, 50));
    else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const found = readDate(record.datePublished, now) ?? readDate(record.dateCreated, now);
      if (found) return found;
      if (record["@graph"]) queue.push(record["@graph"]);
    }
  }
  return null;
}

type Meta = { title: string; description: string; site: string; published: string | null; language: string | null };

function readMeta(document: Tree.Document, url: URL, now: Date): Meta {
  const html = findElement(document, "html");
  const head = html ? findElement(html, "head") : null;
  const meta = new Map<string, string>();
  let title = "";
  let structured: string | null = null;
  for (const node of head ? children(head) : []) {
    if (!isElement(node)) continue;
    if (node.tagName === "title" && !title) title = textOf(node, 500);
    else if (node.tagName === "meta") {
      const name = (attribute(node, "property") || attribute(node, "name") || attribute(node, "itemprop")).toLowerCase();
      const content = attribute(node, "content");
      if (name && content && !meta.has(name)) meta.set(name, content);
    } else if (node.tagName === "script" && attribute(node, "type").toLowerCase() === "application/ld+json") {
      structured ??= publishedInStructuredData(textOf(node, 200_001), now);
    }
  }
  const first = (...names: string[]) => names.map((name) => meta.get(name)).find((value) => value?.trim()) ?? "";
  const published =
    readDate(first("article:published_time", "og:article:published_time", "datepublished", "date", "pubdate", "publish-date", "publish_date", "dc.date", "dc.date.issued", "dcterms.created", "parsely-pub-date", "sailthru.date"), now) ??
    structured;
  return {
    title: cleanText(first("og:title") || title || first("twitter:title"), 200),
    description: cleanText(first("og:description", "description", "twitter:description"), 400),
    site: cleanText(first("og:site_name", "application-name"), 80) || siteOf(url),
    published,
    language: /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(html ? attribute(html, "lang") : "") ? attribute(html as Element, "lang").toLowerCase() : null,
  };
}

/**
 * How much text that is not a link sits under each element. The main part
 * of a page is where most of that is: menus and lists of related articles
 * are nearly all links.
 */
function measure(body: Element): Map<Element, number> {
  const weights = new Map<Element, number>();
  // Post-order, with an explicit stack: children first, then their parent.
  const stack: { element: Element; inContent: boolean; inLink: boolean; visited: boolean }[] = [{ element: body, inContent: false, inLink: false, visited: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as (typeof stack)[number];
    if (frame.visited) {
      stack.pop();
      const parent = frame.element.parentNode;
      if (parent && isElement(parent) && frame.element !== body) weights.set(parent, (weights.get(parent) ?? 0) + (weights.get(frame.element) ?? 0));
      continue;
    }
    frame.visited = true;
    let own = 0;
    const inContent = frame.inContent || isContentRoot(frame.element);
    const inLink = frame.inLink || frame.element.tagName === "a";
    for (const child of children(frame.element)) {
      if (isText(child)) {
        if (!inLink) own += child.value.trim().length;
      } else if (isElement(child) && !isSkipped(child, inContent)) {
        stack.push({ element: child, inContent, inLink, visited: false });
      }
    }
    weights.set(frame.element, (weights.get(frame.element) ?? 0) + own);
  }
  return weights;
}

/** The smallest part of the page that still holds most of its text. */
function mainPart(body: Element, weights: Map<Element, number>): Element {
  let current = body;
  for (let depth = 0; depth < 60; depth++) {
    const total = weights.get(current) ?? 0;
    if (total < 200) break;
    const next = children(current).find((child): child is Element => isElement(child) && (weights.get(child) ?? 0) >= total * 0.75);
    if (!next) break;
    current = next;
  }
  return current;
}

/** Walks the chosen part in reading order and cuts it into blocks of text. */
function readBlocks(root: Element, startsInContent: boolean): string[] {
  const blocks: string[] = [];
  let text = "";
  let linkChars = 0;
  let prefix = "";
  let keepLines = false;

  const flush = () => {
    const cleaned = cleanText(text, MAX_BLOCK_CHARS, { keepLines });
    const letters = cleaned.replace(/[\s|]/g, "").length;
    // A short line that is nearly all link text is a menu entry, not a sentence.
    const mostlyLinks = letters < 200 && linkChars > letters * 0.7 && !prefix.startsWith("#");
    if (letters >= 2 && !mostlyLinks && blocks.at(-1) !== `${prefix}${cleaned}` && blocks.length < MAX_BLOCKS) blocks.push(`${prefix}${cleaned}`);
    text = "";
    linkChars = 0;
    prefix = "";
    keepLines = false;
  };

  type Frame = { node: AnyNode; inContent: boolean; inLink: boolean; inPre: boolean; leave?: () => void };
  const stack: Frame[] = [{ node: root, inContent: startsInContent, inLink: false, inPre: false }];
  while (stack.length > 0 && blocks.length < MAX_BLOCKS) {
    const frame = stack.pop() as Frame;
    if (frame.leave) {
      frame.leave();
      continue;
    }
    const { node } = frame;
    if (isText(node)) {
      const value = frame.inPre ? node.value : node.value.replace(/\s+/g, " ");
      if (text.length < MAX_BLOCK_CHARS * 2) text += value;
      if (frame.inLink) linkChars += value.trim().length;
      continue;
    }
    if (!isElement(node)) continue;
    if (node !== root && isSkipped(node, frame.inContent)) continue;

    const tag = node.tagName;
    const block = BLOCK_TAGS.has(tag);
    if (tag === "br") {
      text += frame.inPre ? "\n" : " ";
      continue;
    }
    if (tag === "hr") {
      flush();
      continue;
    }
    if (block) flush();
    if (HEADINGS.has(tag)) prefix = "# ";
    else if (tag === "li") prefix = "- ";
    else if (tag === "pre") keepLines = true;

    const inContent = frame.inContent || isContentRoot(node);
    const inLink = frame.inLink || tag === "a";
    const inPre = frame.inPre || tag === "pre";
    // What happens when this element is finished, pushed first so it runs last.
    if (block) stack.push({ node, inContent, inLink, inPre, leave: flush });
    else if (tag === "td" || tag === "th") stack.push({ node, inContent, inLink, inPre, leave: () => (text += " | ") });
    const kids = children(node);
    for (let index = kids.length - 1; index >= 0; index--) stack.push({ node: kids[index] as AnyNode, inContent, inLink, inPre });
  }
  flush();
  return blocks.map((block) => block.replace(/(\s*\|\s*)+$/, "").trim()).filter((block) => block.replace(/[#\-\s|]/g, "").length >= 2);
}

/** Turns bytes into text, using the encoding the server or the page itself names. */
export function decodeBody(body: Buffer, charset: string | null): string {
  let label = charset;
  if (!label) {
    if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) label = "utf-8";
    else if (body[0] === 0xff && body[1] === 0xfe) label = "utf-16le";
    else if (body[0] === 0xfe && body[1] === 0xff) label = "utf-16be";
    else {
      // The page may name its own encoding near the top.
      const start = body.subarray(0, 4096).toString("latin1");
      label = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(start)?.[1] ?? "utf-8";
    }
  }
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/** Reads a page of HTML. */
export function extractPage(html: string, url: URL, now: Date = new Date()): Page {
  const document = parse(html, { scriptingEnabled: false });
  const meta = readMeta(document, url, now);
  const body = findElement(document, "body");
  if (!body) return { ...meta, blocks: [] };
  const part = mainPart(body, measure(body));
  let blocks = readBlocks(part, part !== body);
  // If the guess at the main part found almost nothing, the whole page is read instead.
  if (part !== body && blocks.join(" ").length < 200) blocks = readBlocks(body, false);
  // A page that repeats its title as the first heading says it once.
  if (meta.title && blocks[0]?.replace(/^# /, "") === meta.title) blocks = blocks.slice(1);
  return { ...meta, blocks };
}

/** Reads a page that is plain text already. */
export function extractText(text: string, url: URL): Page {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .slice(0, MAX_BLOCKS)
    .map((block) => cleanText(block, MAX_BLOCK_CHARS))
    .filter((block) => block.length >= 2);
  return { title: "", description: "", site: siteOf(url), published: null, language: null, blocks };
}

/** The words of a short piece of HTML, such as a search result's summary with its highlighting. */
export function plainText(fragment: string, maxChars: number): string {
  if (!/[<&]/.test(fragment)) return cleanText(fragment, maxChars);
  return cleanText(textOf(parseFragment(fragment.slice(0, 20_000)), maxChars * 4), maxChars);
}
