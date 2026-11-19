import { looksLikeSecret } from "../ai/secrets.ts";
import { contentWords } from "./select.ts";

// What may leave this machine in a web request, decided by fixed rules.
//
// A search sends its query to a search service; opening a page sends the
// page's address to that site. Both are written by a model, and a model can
// be wrong or can be steered by something it has just read. So neither goes
// out on the model's word alone:
//
//   never    anything that looks like a password or a key
//   ask      a query with a personal detail in it (an email address, a phone
//            or account number), a query made right after Home Base records
//            were read, a query that repeats a value from those records, an
//            address that came neither from a search result nor from the
//            owner, and everything when the owner asked to confirm it all
//   send     the rest: in practice, the owner's own question in other words
//
// "Ask" means the owner sees on screen exactly what would be sent and to
// whom, and nothing is sent before a yes (helios.ts, the approvals).

export type Verdict = { decision: "send" } | { decision: "ask"; because: string } | { decision: "refuse"; because: string };

export type OutboundFacts = {
  /** What the owner said to start this turn. */
  ownerText: string;
  /** True once a Home Base record was read in this turn. */
  recordsRead: boolean;
  /** The text of Home Base records this conversation has read. */
  records: string[];
  /** The owner's setting: every web request needs a yes. */
  confirmEvery: boolean;
};

const SEND: Verdict = { decision: "send" };

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Names the kind of personal detail found in a text, or returns null. */
export function personalDetail(text: string): string | null {
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/.test(text)) return "an email address";
  if (/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/.test(text)) return "a bank account number";
  for (const match of text.matchAll(/\+?\d[\d\s().\/-]{7,}\d/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return "a card number";
    // A date with a time is not a phone number, and neither is a version number ("10.0.19045.3803").
    const written = match[0].trim();
    if (digits.length >= 9 && !/^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}/.test(written) && !/^\d+(\.\d+){2,}$/.test(written)) return "a phone or account number";
  }
  return null;
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
/** Words together with the punctuation inside them: "180.00", "fv-0001-2026". */
const valuesOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.,\-\/:][\p{L}\p{N}]+)*/gu) ?? [];

/** Every text value inside a tool's output (which is JSON for Home Base tools). */
function leaves(output: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return [output];
  }
  const found: string[] = [];
  const queue: unknown[] = [data];
  for (let looked = 0; queue.length > 0 && looked < 5000; looked++) {
    const item = queue.shift();
    if (typeof item === "string") found.push(item);
    else if (typeof item === "number") found.push(String(item));
    else if (Array.isArray(item)) queue.push(...item);
    else if (item && typeof item === "object") queue.push(...Object.values(item));
  }
  return found;
}

/** A number that says something about the owner: not a year, not a small count. */
function tellingValue(value: string): boolean {
  if (!/\d/.test(value) || value.replace(/\D/g, "").length < 3) return false;
  if (/^(19|20)\d{2}$/.test(value)) return false; // a year
  if (/^(19|20)\d{2}-\d{2}(-\d{2})?$/.test(value)) return false; // a date or a month
  return true;
}

/** Words written with a capital inside a value: most likely the name of a person, a company or a place. */
function namesIn(leaf: string): string[] {
  const words = leaf.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((word, index) => index > 0 && word.length >= 4 && /^\p{Lu}/u.test(word) && contentWords(word).length === 1).map((word) => word.toLowerCase());
}

/**
 * The pairs of neighbouring words that carry meaning ("knee scan"), small
 * words left out. Two numbers in a row are not a pair: that is a date or an
 * amount, which the rule for numbers judges.
 */
function pairsOf(text: string): Set<string> {
  const words = contentWords(text);
  const pairs = words.slice(1).map((word, index) => [words[index] as string, word]);
  return new Set(pairs.filter((pair) => !pair.every((word) => /^\d+$/.test(word))).map((pair) => pair.join(" ")));
}

/**
 * True when the query repeats something from the owner's records that the
 * owner did not say in this request: a name, two meaningful words in a row,
 * or a telling number (an amount, an invoice number).
 */
export function repeatsRecords(query: string, records: string[], ownerText: string): boolean {
  if (records.length === 0) return false;
  const queryWords = new Set(wordsOf(query));
  const ownerWords = new Set(wordsOf(ownerText));
  const queryPairs = pairsOf(query);
  const ownerPairs = pairsOf(ownerText);
  const queryValues = new Set(valuesOf(query));
  const ownerValues = new Set(valuesOf(ownerText));

  for (const record of records) {
    for (const leaf of leaves(record)) {
      if (namesIn(leaf).some((name) => queryWords.has(name) && !ownerWords.has(name))) return true;
      for (const pair of pairsOf(leaf)) if (queryPairs.has(pair) && !ownerPairs.has(pair)) return true;
      for (const value of valuesOf(leaf)) if (tellingValue(value) && queryValues.has(value) && !ownerValues.has(value)) return true;
    }
  }
  return false;
}

/** May this query be sent to the search service? */
export function assessSearch(query: string, facts: OutboundFacts): Verdict {
  if (looksLikeSecret(query)) return { decision: "refuse", because: "it looks like it holds a password or a key, and those are never sent anywhere" };
  if (facts.confirmEvery) return { decision: "ask", because: "every web request is set to need your yes" };
  const detail = personalDetail(query);
  if (detail) return { decision: "ask", because: `it holds what looks like ${detail}` };
  if (facts.recordsRead) return { decision: "ask", because: "it was written right after your Home Base records were read" };
  if (repeatsRecords(query, facts.records, facts.ownerText)) return { decision: "ask", because: "it repeats details from your Home Base records" };
  return SEND;
}

/** May this page be requested? `known` means its address came from a search result or from the owner. */
export function assessPage(url: URL, known: boolean, facts: OutboundFacts): Verdict {
  // An address from a search result is the search service's own text. One a model wrote could carry anything.
  if (!known && looksLikeSecret(decodeURIComponent(url.href.replace(/%(?![0-9a-f]{2})/gi, "%25")))) {
    return { decision: "refuse", because: "the address looks like it holds a password or a key, and those are never sent anywhere" };
  }
  if (facts.confirmEvery) return { decision: "ask", because: "every web request is set to need your yes" };
  if (!known) return { decision: "ask", because: "this address came neither from a search result nor from you" };
  return SEND;
}
