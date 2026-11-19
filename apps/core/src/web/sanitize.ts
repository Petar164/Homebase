// Making text from the web safe to hand to a model.
//
// Text from a page is information for HELIOS to weigh, never an instruction
// (the rule is in the system prompt and enforced by the permission checks in
// helios.ts, which do not depend on the model obeying). This file removes
// the cheap tricks that make that rule harder to follow: characters nobody
// can see, and text dressed up as the conversation's own markers.

/**
 * Characters that carry no visible text: controls, formatting marks
 * (zero-width, direction overrides, the invisible "tag" alphabet), private
 * and unassigned code points, and broken halves of a character. Line breaks
 * and tabs are handled separately.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;

/** Sequences some models read as "a new speaker starts here". */
const MARKERS: [RegExp, string][] = [
  [/<\|/g, "< |"],
  [/\|>/g, "| >"],
  [/\[\s*\/?\s*INST\s*\]/gi, "(INST)"],
  [/<<\s*\/?\s*SYS\s*>>/gi, "(SYS)"],
  [/<\s*\/?\s*(system|assistant|user|tool|developer)\s*>/gi, "($1)"],
  // The words the core itself uses to mark its own notes to the model.
  [/Note from Home Base/gi, 'the words "Note from Home-Base" (written on the page)'],
];

/**
 * Cleans one piece of web text: one line, no invisible characters, no
 * imitation of conversation markers, at most `maxChars` long.
 */
export function cleanText(text: string, maxChars = 4000, options: { keepLines?: boolean } = {}): string {
  // Line breaks and tabs become ordinary spacing first, so that removing
  // the invisible characters cannot glue two words together.
  let out = text.normalize("NFKC").replace(/\r\n?/g, "\n");
  out = options.keepLines ? out.replace(/[^\S\n]+/g, " ") : out.replace(/\s+/g, " ");
  out = out.replace(INVISIBLE, (character) => (character === "\n" ? "\n" : ""));
  out = options.keepLines ? out.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n") : out.replace(/ {2,}/g, " ");
  for (const [pattern, replacement] of MARKERS) out = out.replace(pattern, replacement);
  out = out.trim();
  return out.length > maxChars ? cutAtWord(out, maxChars) : out;
}

/** Shortens text to at most `maxChars`, ending on a whole word, with a mark that it was cut. */
export function cutAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return "…".slice(0, Math.max(0, maxChars));
  const slice = text.slice(0, maxChars - 1);
  // Prefer the end of a sentence if one is near, otherwise the end of a word.
  const sentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "));
  if (sentence > maxChars * 0.6) return `${slice.slice(0, sentence + 1)} …`.slice(0, maxChars);
  const word = slice.lastIndexOf(" ");
  return `${(word > maxChars * 0.5 ? slice.slice(0, word) : slice).trimEnd()}…`;
}
