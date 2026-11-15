import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider } from "./types.ts";

// The local model, through Ollama's HTTP API on this machine. Nothing a
// local model is given leaves the computer, so it needs no approval.
//
// NOT YET RUN AGAINST A REAL OLLAMA: none is installed on the development
// machine. The request and response shapes below are written from Ollama's
// documented /api/chat and /api/tags endpoints and are exercised by tests
// against a fake server only. Verify on the laptop before relying on it.

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
};

type OllamaChatResponse = {
  model?: string;
  message?: { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

function toOllamaMessages(system: string, messages: ChatMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") out.push({ role: "user", content: message.text });
    else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text,
        ...(message.toolCalls.length > 0 ? { tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.input } })) } : {}),
      });
    } else {
      for (const result of message.results) out.push({ role: "tool", content: result.output, tool_name: result.name });
    }
  }
  return out;
}

/** How long an answer to "is the local model there?" is reused. */
const AVAILABILITY_SECONDS = 30;

export class OllamaProvider implements ModelProvider {
  readonly id = "ollama";
  readonly location = "local" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private checked: { at: number; ok: boolean } | null = null;
  private calls = 0;

  constructor(options: { baseUrl: string; model: string; fetch?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.fetch = options.fetch ?? fetch;
  }

  /** True when Ollama is running and has the configured model. */
  async available(): Promise<boolean> {
    if (!this.model) return false;
    if (this.checked && Date.now() - this.checked.at < AVAILABILITY_SECONDS * 1000) return this.checked.ok;
    let ok = false;
    try {
      const response = await this.fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const data = (await response.json()) as { models?: { name: string }[] };
      ok = response.ok && (data.models ?? []).some((entry) => entry.name === this.model || entry.name === `${this.model}:latest`);
    } catch {
      ok = false;
    }
    this.checked = { at: Date.now(), ok };
    return ok;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: request.signal,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: toOllamaMessages(request.system, request.messages),
        tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      }),
    });
    if (!response.ok) throw new Error(`The local model answered with status ${response.status}.`);
    const data = (await response.json()) as OllamaChatResponse;

    const text = data.message?.content ?? "";
    // Ollama does not give tool requests an id, so the core's pairing of
    // request and result needs one made here.
    const toolCalls = (data.message?.tool_calls ?? []).map((call) => ({ id: `ollama-${Date.now()}-${++this.calls}`, name: call.function.name, input: call.function.arguments }));
    if (text) request.onText?.(text);
    return {
      text,
      toolCalls,
      stop: toolCalls.length > 0 ? "tool_use" : data.done_reason === "length" ? "max_tokens" : "end",
      usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 },
      model: data.model ?? this.model,
    };
  }
}
