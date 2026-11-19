// The one interface every model sits behind. HELIOS's own logic (the turn
// loop, tools, permissions) only knows these shapes, so a local model, a
// cloud model and a scripted test model are interchangeable, and no part of
// the system depends on one vendor.

import type { WebSource } from "@homebase/shared";

/** How private a piece of text is. Higher labels restrict where it may be sent. */
export const SENSITIVITY = ["normal", "private", "sensitive", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];

export function maxSensitivity(...labels: Sensitivity[]): Sensitivity {
  return labels.reduce<Sensitivity>((highest, label) => (SENSITIVITY.indexOf(label) > SENSITIVITY.indexOf(highest) ? label : highest), "normal");
}

/** A model asking to use a tool. `input` is unchecked until the core validates it. */
export type ToolCall = { id: string; name: string; input: unknown };

/**
 * What a tool returned. `output` is what a model is shown. The rest is kept
 * with the transcript and never sent to a model:
 *   brief    a short form of `output`, shown instead once the turn is over
 *   sources  web pages this result brought into the conversation
 *   web      what a web request did: whether anything was sent and came back
 */
export type ToolResult = {
  id: string;
  name: string;
  output: string;
  isError: boolean;
  brief?: string;
  sources?: WebSource[];
  web?: WebNote;
};

export type WebNote = {
  kind: "search" | "page";
  /** True when the request left this machine, whether or not an answer came back. */
  sent: boolean;
  /** True when content came back and is in `output`. */
  ok: boolean;
  /** Who it was sent to: the search service's name, or the site. */
  to: string;
  /** How many bytes the request itself carried (the query, or the address). */
  bytes: number;
  /** Why it did not work, in words for the owner. */
  failure?: string;
};

export type ChatMessage =
  | { role: "user"; text: string }
  /**
   * `raw` is the provider's own representation of this answer. It is handed
   * back to the same provider unchanged when the conversation continues.
   */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; provider: string; raw?: unknown }
  | { role: "tool"; results: ToolResult[] };

/** What a model is told about a tool: its name, purpose and input shape (JSON Schema). */
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type ChatRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Called with each piece of text as it is produced, for live display. */
  onText?: (delta: string) => void;
};

export type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  /** Why the model stopped. "refusal" means the provider declined the request. */
  stop: "end" | "tool_use" | "max_tokens" | "refusal";
  /** cacheWriteTokens are input tokens the provider stored for reuse (billed above the normal rate). */
  usage: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number };
  model: string;
  raw?: unknown;
};

/**
 * What a provider is for. The router picks by role, never by model name:
 *   local    the model on this machine; the default for ordinary requests
 *   strong   the cloud model for hard reasoning
 *   light    the cheap cloud model for extraction and background work
 *   standin  fixed rules, used only while no real model exists
 */
export type ProviderRole = "local" | "strong" | "light" | "standin";

export interface ModelProvider {
  /** Short name used in logs and the database: "standin", "ollama", "claude-strong", "claude-light". */
  readonly id: string;
  readonly role: ProviderRole;
  /** "cloud" providers send data off this machine and go through the approval gate. */
  readonly location: "local" | "cloud";
  readonly model: string;
  /** True when the provider can answer right now (key present, server running). */
  available(): Promise<boolean>;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
