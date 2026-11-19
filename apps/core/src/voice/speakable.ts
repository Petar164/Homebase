// What of an answer is said aloud.
//
// An answer that used the web carries marks for the screen: source numbers
// like [1], and now and then a web address. Read out, "[1]" is noise and an
// address is half a minute of "h t t p s colon slash slash". So the voice
// says the sentence without them, and names a site by its name. The screen
// still shows everything, with the links.
//
// Text without such marks is returned exactly as it came.

/**
 * "[1]", "[2, 3]", "[3][4]": the number of a source. A number in brackets
 * that is attached to a word ("items[0]") is not one.
 */
const SOURCE_MARK = /(?:\s+|(?<![\p{L}\p{N}_\]]))(?:\[\d{1,6}(?:\s*[,;]\s*\d{1,6})*\])+/gu;
/** "[the report](https://example.org/r)": the words stay, the address goes. */
const LINK = /\[([^\]\n]{1,200})\]\((?:https?:\/\/)[^)\s]+\)/g;
/** A written-out address: only the site's name is said. */
const ADDRESS = /\bhttps?:\/\/(?:www\.)?([a-z0-9.-]+)[^\s<>"'`)\]]*/gi;

export function speakable(text: string): string {
  const stripped = text.replace(LINK, "$1").replace(SOURCE_MARK, "").replace(ADDRESS, (_whole, site: string) => site.replace(/\.$/, ""));
  if (stripped === text) return text.trim();
  return stripped
    .replace(/\(\s*\)/g, "") // brackets that held only a mark
    .replace(/[,;:]\s*(?=[.,;:!?])/g, "") // "see:." after an address was the whole clause
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.,;:!?]+$/, "") // nothing left but punctuation: nothing to say
    .trim();
}
