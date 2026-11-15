import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider, ToolCall } from "./types.ts";

// The cloud model: Claude, through Anthropic's official SDK.
//
// NOT YET RUN AGAINST THE REAL API: no key exists on the development
// machine. The request shape follows the SDK's documentation and the tests
// check how conversations are translated, but the first real call still has
// to be made once a key is set up.
//
// Credentials are never in this code or in the repository. The SDK reads
// them from the environment (ANTHROPIC_API_KEY) when a request is made.

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Block = Anthropic.Beta.BetaContentBlock;
type Param = Anthropic.Beta.BetaMessageParam;
/** The SDK's own type for a streaming request, so the compiler checks every field name used below. */
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** The part of the SDK client this provider uses. Tests pass a fake with the same shape. */
export type ClaudeClient = {
  beta: {
    messages: {
      stream(params: Record<string, unknown>, options?: { signal?: AbortSignal }): {
        on(event: "text", listener: (delta: string) => void): unknown;
        finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
      };
    };
  };
};

/**
 * Translates the transcript into the form the API expects.
 *
 * The current turn (everything after the owner's latest message) is sent
 * back exactly as the model produced it, reasoning blocks included: the API
 * needs them unchanged to continue a tool exchange. Earlier turns are sent
 * as their words and tool requests only. Dropping reasoning from the oldest
 * turns first is allowed; changing anything else about earlier messages is
 * not, which is why the core never edits or trims a turn in progress.
 */
export function toClaudeMessages(messages: ChatMessage[]): Param[] {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  return messages.map((message, index): Param => {
    if (message.role === "user") return { role: "user", content: message.text };
    if (message.role === "tool") {
      return {
        role: "user",
        content: message.results.map((result) => ({ type: "tool_result" as const, tool_use_id: result.id, content: result.output, is_error: result.isError })),
      };
    }
    if (index > lastUser && message.provider === "claude" && Array.isArray(message.raw)) {
      return { role: "assistant", content: message.raw as Block[] };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (message.text) content.push({ type: "text", text: message.text });
    for (const call of message.toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    // The API does not accept an empty turn.
    return { role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "(no reply)" }] };
  });
}

export class ClaudeProvider implements ModelProvider {
  readonly id = "claude";
  readonly location = "cloud" as const;
  readonly model: string;
  private readonly effort: Effort;
  private readonly env: NodeJS.ProcessEnv;
  private client: ClaudeClient | null;

  constructor(options: { model: string; effort?: Effort; client?: ClaudeClient; env?: NodeJS.ProcessEnv }) {
    this.model = options.model;
    this.effort = options.effort ?? "medium";
    this.client = options.client ?? null;
    this.env = options.env ?? process.env;
  }

  /** Usable once a key is present. Nothing is sent to find this out. */
  async available(): Promise<boolean> {
    return this.client !== null || Boolean(this.env.ANTHROPIC_API_KEY || this.env.ANTHROPIC_AUTH_TOKEN);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.client ??= new Anthropic() as unknown as ClaudeClient;

    const params = {
      model: this.model,
      max_tokens: 64_000,
      system: request.system,
      // eager_input_streaming: tool inputs arrive as they are written. The
      // API then no longer checks them, which is fine here: the core checks
      // every tool input against its schema before running anything.
      tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema, eager_input_streaming: true })),
      messages: toClaudeMessages(request.messages),
      // How hard the model thinks. Spoken answers should come quickly.
      output_config: { effort: this.effort },
      // Lets the unchanged beginning of the conversation be reused cheaply.
      cache_control: { type: "ephemeral" },
      // If the model declines a request for policy reasons, the API may
      // answer with another Claude model instead of returning nothing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } satisfies StreamParams;

    let message: Anthropic.Beta.BetaMessage;
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(params, { signal: request.signal });
      stream.on("text", (delta) => request.onText?.(delta));
      try {
        message = await stream.finalMessage();
        break;
      } catch (error) {
        // A tool input that could not be read at all is asked for again, twice
        // at most. Errors from the API itself (bad key, rate limit) are not retried here.
        if (error instanceof Anthropic.APIError || attempt >= 2) throw error;
      }
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    // Tool requests are only honoured when the model stopped in order to use
    // them. An answer cut off at the length limit, or declined, can contain
    // half-written requests that must never run.
    const toolCalls: ToolCall[] =
      message.stop_reason === "tool_use"
        ? message.content
            .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
            .map((block) => ({ id: block.id, name: block.name, input: block.input }))
        : [];
    const stop: ChatResponse["stop"] =
      message.stop_reason === "refusal" ? "refusal" : message.stop_reason === "max_tokens" ? "max_tokens" : toolCalls.length > 0 ? "tool_use" : "end";

    const usage = message.usage;
    return {
      text,
      toolCalls,
      stop,
      // Cached input is cheaper than this counts it; over-counting keeps the spending cap on the safe side.
      usage: { inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens },
      model: message.model,
      raw: message.content,
    };
  }
}
