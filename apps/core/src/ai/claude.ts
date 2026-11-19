import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { type AttemptUsage, type ChatMessage, type ChatRequest, type ChatResponse, type ModelProvider, ProviderError, type ToolCall } from "./types.ts";

// The cloud model: Claude, through Anthropic's official SDK.
//
// NOT YET RUN AGAINST THE REAL API: no key exists on the development
// machine. The request follows the SDK's documentation and its own types,
// and the tests check every translation with a stand-in client, but the
// first real call still has to be made once a key is set up
// (docs/CLAUDE-API.md).
//
// The key is never in this code or in the repository. It is read from the
// environment (ANTHROPIC_API_KEY, which the core loads from the .env file)
// when a request is made, and handed to the SDK and to nothing else.

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type Block = Anthropic.Beta.BetaContentBlock;
type Param = Anthropic.Beta.BetaMessageParam;
/** The SDK's own type for a streaming request, so the compiler checks every field name used below. */
type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

/** Where requests go unless the owner's settings name another address. */
export const ANTHROPIC_API = "https://api.anthropic.com";
/** How long one request may take. A request that hangs should fail while the owner is still waiting for it. */
const REQUEST_TIMEOUT_MS = 120_000;
/** How often the SDK itself repeats a request that got no answer at all (a dropped connection, an overloaded service). */
const MAX_RETRIES = 1;

/** The part of the SDK client this provider uses. Tests pass a fake with the same shape. */
export type ClaudeClient = {
  beta: {
    messages: {
      stream(params: StreamParams, options?: { signal?: AbortSignal }): {
        /** Called once Anthropic has accepted the request and begun to answer. */
        on(event: "connect", listener: () => void): unknown;
        on(event: "text", listener: (delta: string) => void): unknown;
        finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
      };
    };
  };
};

// ---------- the key, and where it may be sent ----------

/**
 * Reads the API key. Only ANTHROPIC_API_KEY counts. The SDK would also
 * accept a sign-in token, a profile left on disk by another tool, or an
 * address from another variable; HELIOS uses none of those, so that a
 * credential nobody set up for it is never used by accident.
 */
export function readClaudeKey(env: NodeJS.ProcessEnv): { key: string } | { problem: string } {
  const key = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) return { problem: "no API key is set (ANTHROPIC_API_KEY in the .env file)" };
  // A key with a space or a line break in it would make a broken request, and the error for that could repeat the key.
  if (!/^[\x21-\x7e]+$/.test(key)) return { problem: "the value of ANTHROPIC_API_KEY has a space or a line break in it" };
  if (key.startsWith("sk-ant-admin")) return { problem: "ANTHROPIC_API_KEY holds an Admin key, which can manage the whole account. HELIOS needs an ordinary API key" };
  if (key.startsWith("sk-ant-oat")) return { problem: "ANTHROPIC_API_KEY holds the sign-in token of a Claude subscription, not an API key. API use is billed on its own and needs a key from the Anthropic Console" };
  return { key };
}

/**
 * The address requests go to. Anthropic's own, unless the owner's settings
 * name another (a gateway, or a stand-in on this machine for a test). The
 * key travels with every request, so another address must be encrypted,
 * or be this machine itself.
 */
export function claudeEndpoint(configured: string): { url: string; host: string | null } | { problem: string } {
  const raw = configured.trim();
  if (!raw) return { url: ANTHROPIC_API, host: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { problem: "the address in ai.cloud.baseUrl cannot be read" };
  }
  if (parsed.username || parsed.password) return { problem: "the address in ai.cloud.baseUrl must not hold a name or a password" };
  const thisMachine = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && thisMachine)) return { problem: "the address in ai.cloud.baseUrl must begin with https://" };
  return { url: raw.replace(/\/+$/, ""), host: parsed.host };
}

// ---------- the conversation, in the API's form ----------

/**
 * What is sent back of an answer that was begun by one model and finished
 * by another (the API marks the hand-over with a "fallback" block). Of the
 * part before the last hand-over only the words and the marks themselves go
 * back: the first model's reasoning and its half-made tool requests must be
 * left out, and the marks must stay exactly where they were.
 */
function echo(blocks: Block[]): Block[] {
  const boundary = blocks.findLastIndex((block) => block.type === "fallback");
  if (boundary === -1) return blocks;
  return blocks.filter((block, index) => index >= boundary || block.type === "text" || block.type === "fallback");
}

/**
 * Translates the transcript into the form the API expects.
 *
 * The current turn (everything after the owner's latest message) is sent
 * back exactly as the model produced it, reasoning blocks included. Earlier
 * turns are sent as their words and tool requests only. That is allowed:
 * reasoning may be left out from the oldest turn onwards. What is not
 * allowed is changing anything else that came before a reasoning block
 * that is sent back, which is why the core never edits or trims a turn in
 * progress.
 *
 * With `reasoning: false` no reasoning is sent back at all. The answer is
 * then given without it, and the request cannot be turned down over it.
 */
export function toClaudeMessages(messages: ChatMessage[], providerId: string, options: { reasoning?: boolean } = {}): Param[] {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  return messages.map((message, index): Param => {
    if (message.role === "user") return { role: "user", content: message.text };
    if (message.role === "tool") {
      return {
        role: "user",
        content: message.results.map((result) => ({ type: "tool_result" as const, tool_use_id: result.id, content: result.output, is_error: result.isError })),
      };
    }
    // Reasoning blocks are tied to the model that wrote them, so only this
    // provider's own answers are replayed as-is.
    if (options.reasoning !== false && index > lastUser && message.provider === providerId && Array.isArray(message.raw)) {
      return { role: "assistant", content: echo(message.raw as Block[]) };
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (message.text) content.push({ type: "text", text: message.text });
    for (const call of message.toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    // The API does not accept an empty turn.
    return { role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "(no reply)" }] };
  });
}

function carriesReasoning(messages: Param[]): boolean {
  return messages.some((message) => message.role === "assistant" && Array.isArray(message.content) && message.content.some((block) => block.type === "thinking" || block.type === "redacted_thinking"));
}

// ---------- what went wrong, in words for the owner ----------

/**
 * Turns a failed request into what it was. Nothing of the SDK's or the
 * API's own error text is passed on: it can quote the request. `started` is
 * true when Anthropic had accepted the request and begun to answer, which
 * is when a failure can still cost money.
 */
export function toProviderError(error: unknown, model: string, started: boolean): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new ProviderError("aborted", "The request to Claude was stopped.", started);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("timeout", "Claude did not answer in time.", started);
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError("network", started ? "The connection to Anthropic broke off in the middle of the answer." : "Anthropic could not be reached. Check the internet connection.", started);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const type = error.type;
    if (status === 401 || type === "authentication_error") return new ProviderError("auth", "Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in the .env file.");
    if (status === 402 || type === "billing_error") {
      return new ProviderError("billing", "Anthropic reports a billing problem. The API account may have no credit left; a Claude subscription does not include any.");
    }
    if (status === 403 || type === "permission_error") return new ProviderError("permission", `This API key is not allowed to use ${model}.`);
    if (status === 404 || type === "not_found_error") return new ProviderError("model", `Anthropic does not offer a model called ${model} to this account. Check the model names in config.json.`);
    if (status === 429 || type === "rate_limit_error") {
      return new ProviderError("rate_limit", "Anthropic is limiting requests from this account right now, or the spending limit set on the account itself is reached.");
    }
    if (status === 413) return new ProviderError("invalid", "The conversation is too large to send to Claude in one request.");
    if (status >= 500 || type === "overloaded_error" || type === "api_error" || type === "timeout_error") {
      return new ProviderError("unavailable", "Anthropic's service is overloaded or having trouble right now.", started);
    }
    return new ProviderError("invalid", "Anthropic did not accept the request.");
  }
  // An answer arrived and could not be read: for example a tool request that is not valid JSON.
  return new ProviderError("malformed", "Claude's answer could not be read.", true);
}

// ---------- the provider ----------

export class ClaudeProvider implements ModelProvider {
  readonly id: string;
  readonly role: "strong" | "light";
  readonly location = "cloud" as const;
  readonly model: string;
  private readonly effort: Effort;
  private readonly maxOutputTokens: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly baseUrl: string;
  private readonly createClient: (options: ClientOptions) => ClaudeClient;
  /** A client handed in from outside (a test's stand-in) is used as it is, without a key. */
  private readonly given: boolean;
  private client: ClaudeClient | null;

  constructor(options: {
    role?: "strong" | "light";
    model: string;
    effort?: Effort;
    maxOutputTokens?: number;
    /** Another address than Anthropic's own (config.ai.cloud.baseUrl). */
    baseUrl?: string;
    client?: ClaudeClient;
    env?: NodeJS.ProcessEnv;
    createClient?: (options: ClientOptions) => ClaudeClient;
  }) {
    this.role = options.role ?? "strong";
    this.id = `claude-${this.role}`;
    this.model = options.model;
    this.effort = options.effort ?? "medium";
    // Sent to the API as the limit for one answer, and therefore also the
    // most a single call can cost in output (see the budget in policy.ts).
    this.maxOutputTokens = options.maxOutputTokens ?? 8000;
    this.baseUrl = options.baseUrl ?? "";
    this.client = options.client ?? null;
    this.given = options.client !== undefined;
    this.env = options.env ?? process.env;
    this.createClient = options.createClient ?? ((clientOptions) => new Anthropic(clientOptions) as unknown as ClaudeClient);
  }

  /** Who the conversation goes to, and what stands in the way of sending it. Nothing is sent to find this out. */
  describe(): { service: string; problem: string | null } {
    const endpoint = claudeEndpoint(this.baseUrl);
    if ("problem" in endpoint) return { service: "Anthropic", problem: endpoint.problem };
    const service = endpoint.host ? `Anthropic by way of ${endpoint.host}` : "Anthropic";
    if (this.given) return { service, problem: null };
    const key = readClaudeKey(this.env);
    return { service, problem: "problem" in key ? key.problem : null };
  }

  /** Usable once a key is present. Whether the owner has switched cloud models on is decided elsewhere (policy.ts). */
  async available(): Promise<boolean> {
    return this.describe().problem === null;
  }

  private connect(): ClaudeClient {
    if (this.client) return this.client;
    const endpoint = claudeEndpoint(this.baseUrl);
    if ("problem" in endpoint) throw new ProviderError("invalid", `Claude is not set up: ${endpoint.problem}.`);
    const key = readClaudeKey(this.env);
    if ("problem" in key) throw new ProviderError("auth", `Claude is not set up: ${key.problem}.`);
    // Everything the SDK would otherwise take from the surroundings is said
    // here: which key, which address, how patient to be. Its own logging is
    // off, because at its most talkative it prints what was asked.
    this.client = this.createClient({ apiKey: key.key, baseURL: endpoint.url, maxRetries: MAX_RETRIES, timeout: REQUEST_TIMEOUT_MS, logLevel: "off" });
    return this.client;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const client = this.connect();
    // Reasoning from earlier in this turn is sent back, unless the API turns the request down with it.
    let reasoning = true;
    for (;;) {
      const messages = toClaudeMessages(request.messages, this.id, { reasoning });
      const params: StreamParams = {
        model: this.model,
        max_tokens: this.maxOutputTokens,
        system: request.system,
        // eager_input_streaming: tool inputs arrive as they are written. The
        // API then no longer checks them, which is fine here: the core checks
        // every tool input against its schema before running anything.
        tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema, eager_input_streaming: true })),
        messages,
        // How hard the model thinks. Spoken answers should come quickly.
        output_config: { effort: this.effort },
        // Lets the unchanged beginning of the conversation be reused cheaply.
        cache_control: { type: "ephemeral" },
      };
      // If the strong model declines a request for policy reasons, the API may
      // answer with another Claude model instead of returning nothing. The
      // light model (Haiku) has no such fallback and must not be sent this.
      if (this.role === "strong") {
        params.betas = ["server-side-fallback-2026-07-01"];
        params.fallbacks = "default";
      }

      let started = false;
      try {
        const stream = client.beta.messages.stream(params, { signal: request.signal });
        stream.on("connect", () => {
          started = true;
        });
        stream.on("text", (delta) => request.onText?.(delta));
        return this.read(await stream.finalMessage());
      } catch (error) {
        // The API checks that reasoning it gets back still belongs to the
        // same conversation, and turns the whole request down when it finds
        // otherwise. Such a request costs nothing and has produced nothing,
        // so it is asked once more without the reasoning. Any other request
        // that fails is not repeated here.
        if (reasoning && error instanceof Anthropic.BadRequestError && carriesReasoning(messages)) {
          reasoning = false;
          continue;
        }
        throw toProviderError(error, this.model, started);
      }
    }
  }

  private read(message: Anthropic.Beta.BetaMessage): ChatResponse {
    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    // Tool requests are only honoured when the model stopped in order to use
    // them. An answer cut off at the length limit, or declined, can contain
    // half-written requests that must never run. And when one model handed
    // over to another in the middle of the answer, only the requests of the
    // model that finished it count: the API forgets the first model's.
    const boundary = message.content.findLastIndex((block) => block.type === "fallback");
    const toolCalls: ToolCall[] =
      message.stop_reason === "tool_use"
        ? message.content
            .slice(boundary + 1)
            .filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use")
            .map((block) => ({ id: block.id, name: block.name, input: block.input }))
        : [];
    const cutOff = message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded";
    const stop: ChatResponse["stop"] = message.stop_reason === "refusal" ? "refusal" : cutOff ? "max_tokens" : toolCalls.length > 0 ? "tool_use" : "end";

    // Cached input is cheaper than this counts it; over-counting keeps the spending cap on the safe side.
    const count = (part: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }, model: string): AttemptUsage => ({
      model,
      inputTokens: part.input_tokens + (part.cache_creation_input_tokens ?? 0) + (part.cache_read_input_tokens ?? 0),
      cacheWriteTokens: part.cache_creation_input_tokens ?? 0,
      outputTokens: part.output_tokens,
    });
    const { model: _answeredBy, ...answer } = count(message.usage, message.model);
    // When one model declined and another answered, both attempts are on the
    // bill, each at its own model's price. The API lists them one by one;
    // its totals cover the last attempt only.
    const attempts = (message.usage.iterations ?? [])
      .filter((entry) => entry.type === "message" || entry.type === "fallback_message")
      .map((entry) => count(entry, entry.model ?? this.model));

    return {
      text,
      toolCalls,
      stop,
      usage: { ...answer, ...(attempts.length > 1 ? { attempts } : {}) },
      model: message.model,
      raw: message.content,
    };
  }
}
