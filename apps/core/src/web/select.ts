import { cutAtWord } from "./sanitize.ts";

// Choosing which part of a page a model gets to see.
//
// A page can be many times longer than the room a small local model has
// (a few thousand characters when its whole window is 4,096 tokens). Taking
// the first so-many characters would often give it the introduction and
// miss the answer. So the page is cut into its paragraphs, each paragraph
// is scored against the question by the words they share, and the best
// ones are kept, in their original order, with a mark where something was
// left out. No model is involved: the same page and question always give
// the same excerpt.

const STOPWORDS = new Set(
  ("a an and are as at be been being but by can could did do does for from had has have how i if in into is it its just me my of on or our " +
    "should so some such than that the their them then there these they this those to was we were what when where which who why will with would you your about also any all " +
    "tell say says said find look search web internet page site please").split(" "),
);

/** The words of a text that carry meaning, in a simple common form ("models" and "model" count as one). */
export function contentWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((word) => (word.length >= 3 || /^\d+$/.test(word)) && !STOPWORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

export type Selection = {
  text: string;
  /** True when part of the page was left out. */
  cut: boolean;
};

/** What separates two kept paragraphs when something between them was left out. */
const GAP = "[…]";

/**
 * Picks the paragraphs that best match `question`, to fit in `budgetChars`.
 * The opening of the page is always kept: it usually says what the page is.
 */
export function selectPassages(blocks: string[], question: string, budgetChars: number): Selection {
  const budget = Math.max(0, Math.floor(budgetChars));
  const whole = blocks.join("\n");
  if (whole.length <= budget) return { text: whole, cut: false };
  if (blocks.length === 0 || budget === 0) return { text: "", cut: blocks.length > 0 };

  // Score every paragraph against the question (BM25: a word counts for
  // more when few paragraphs have it, and for less each time it repeats).
  const terms = [...new Set(contentWords(question))];
  const words = blocks.map((block) => contentWords(block));
  const averageLength = words.reduce((sum, list) => sum + list.length, 0) / blocks.length || 1;
  const weight = new Map<string, number>();
  for (const term of terms) {
    const having = words.filter((list) => list.includes(term)).length;
    weight.set(term, Math.log(1 + (blocks.length - having + 0.5) / (having + 0.5)));
  }
  const scores = words.map((list, index) => {
    let score = 0;
    for (const term of terms) {
      const count = list.filter((word) => word === term).length;
      if (count > 0) score += ((weight.get(term) ?? 0) * (count * 2.2)) / (count + 1.2 * (0.25 + (0.75 * list.length) / averageLength));
    }
    return blocks[index]?.startsWith("# ") ? score * 1.5 : score;
  });

  const chosen = new Map<number, string>();
  let used = 0;
  /** Adds a paragraph if it fits, cut short if only most of it does. */
  const take = (index: number, mayCut: boolean): boolean => {
    const block = blocks[index];
    if (block === undefined || chosen.has(index)) return false;
    // Each kept paragraph may need a line break and, before it, a gap mark.
    const room = budget - used - 1 - (GAP.length + 1);
    if (block.length <= room) {
      chosen.set(index, block);
      used += block.length + 1 + GAP.length + 1;
      return true;
    }
    if (!mayCut || room < 160) return false;
    chosen.set(index, cutAtWord(block, room));
    used = budget;
    return true;
  };

  // 1. The opening, up to a fifth of the room (or all of it when nothing matches the question).
  const matched = scores.some((score) => score > 0);
  const openingRoom = matched ? budget * 0.2 : budget;
  for (let index = 0; index < blocks.length && used < openingRoom; index++) {
    if (!take(index, true)) break;
  }
  // 2. The best-matching paragraphs, each with the heading it stands under.
  const ranked = scores.map((score, index) => ({ score, index })).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { index } of ranked) {
    if (used >= budget) break;
    if (!blocks[index]?.startsWith("# ")) {
      for (let before = index - 1; before >= 0 && before >= index - 12; before--) {
        if (blocks[before]?.startsWith("# ")) {
          take(before, false);
          break;
        }
      }
    }
    take(index, true);
  }

  const kept = [...chosen.keys()].sort((a, b) => a - b);
  const lines: string[] = [];
  kept.forEach((index, position) => {
    const previous = kept[position - 1];
    if (previous !== undefined ? index !== previous + 1 : index !== 0) lines.push(GAP);
    lines.push(chosen.get(index) as string);
  });
  if ((kept.at(-1) ?? -1) < blocks.length - 1) lines.push(GAP);
  return { text: lines.join("\n").slice(0, budget), cut: true };
}
