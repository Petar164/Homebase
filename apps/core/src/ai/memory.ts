import type { Db } from "../db/open.ts";
import { maxSensitivity, type Sensitivity } from "./types.ts";

// Memory, first layer: finding what was said before. This is plain
// full-text search over stored conversations, running entirely on this
// machine. Meaning-based search (embeddings), summaries and extracted
// decisions come in phase 3 and will sit on top of the same records.

export type MemoryHit = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  role: "user" | "assistant";
  at: string;
  /** The part of the message around the match. */
  snippet: string;
  sensitivity: Sensitivity;
};

/**
 * Turns what a person typed into a safe search expression. The search
 * engine has its own query language (quotes, *, AND, NEAR, column filters);
 * passing text through untouched would let odd input cause errors or
 * search in unintended ways. Here every word is quoted, so it is only ever
 * a word, and any of the words may match.
 */
export function toSearchExpression(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, 12).map((word) => `"${word}"`).join(" OR ");
}

/** The best matches for `query`, most relevant first. */
export function searchConversations(db: Db, query: string, options: { limit?: number; excludeConversationId?: string } = {}): MemoryHit[] {
  const expression = toSearchExpression(query);
  if (!expression) return [];
  const rows = db
    .prepare(
      `SELECT m.id AS messageId, m.conversation_id AS conversationId, c.title AS conversationTitle, m.role, m.created_at AS at, m.sensitivity,
              snippet(messages_fts, 0, '', '', ' … ', 28) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.message_id
       JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ? AND c.deleted_at IS NULL AND m.conversation_id != ?
       ORDER BY bm25(messages_fts)
       LIMIT ?`,
    )
    .all(expression, options.excludeConversationId ?? "", options.limit ?? 6) as MemoryHit[];
  return rows;
}

/** The highest label among the hits: a search result is as private as its most private part. */
export function hitsSensitivity(hits: MemoryHit[]): Sensitivity {
  return maxSensitivity("private", ...hits.map((hit) => hit.sensitivity));
}
