// The one interface every model sits behind. HELIOS's own logic (the turn
// loop, tools, permissions) only knows these shapes, so a local model, a
// cloud model and a scripted test model are interchangeable, and no part of
// the system depends on one vendor.

/** How private a piece of text is. Higher labels restrict where it may be sent. */
export const SENSITIVITY = ["normal", "private", "sensitive", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];

export function maxSensitivity(...labels: Sensitivity[]): Sensitivity {
  return labels.reduce<Sensitivity>((highest, label) => (SENSITIVITY.indexOf(label) > SENSITIVITY.indexOf(highest) ? label : highest), "normal");
}

/** A model asking to use a tool. `input` is unchecked until the core validates it. */
export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = { id: string; name: string; output: string; isError: boolean };

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
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  raw?: unknown;
};

export interface ModelProvider {
  /** Short name used in logs and the database: "standin", "claude", "ollama". */
  readonly id: string;
  /** "cloud" providers send data off this machine and go through the approval gate. */
  readonly location: "local" | "cloud";
  readonly model: string;
  /** True when the provider can answer right now (key present, server running). */
  available(): Promise<boolean>;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
