import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ANTHROPIC_API, type ClaudeClient, claudeEndpoint, ClaudeProvider, readClaudeKey, toClaudeMessages, toProviderError } from "../src/ai/claude.ts";
import { Helios } from "../src/ai/helios.ts";
import { budgetStatus } from "../src/ai/policy.ts";
import { StandInProvider } from "../src/ai/standin.ts";
import { type ChatMessage, type ChatRequest, type ChatResponse, type ModelProvider, ProviderError, type ProviderRole } from "../src/ai/types.ts";
import { defaultConfig, saveConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { buildServer } from "../src/http/server.ts";
import { type Instance, openInstance } from "../src/instance.ts";
import { dataPaths } from "../src/paths.ts";
import { setOwnerPassword } from "../src/security/owner.ts";
import { silentLogger } from "../src/util.ts";
import { taskTitles, tempDir, track } from "./helpers.ts";

// Claude as an optional cloud model: the key, the switch, what is read out
// of an answer, what happens when it fails, and what that may cost.
//
// Nothing here reaches Anthropic. The SDK client is a stand-in that answers
// what each test scripted, and no test needs a key. These tests do NOT show
// that the real API accepts the requests; that takes one real call
// (docs/CLAUDE-API.md).

/** A value shaped like nothing in particular. It only has to be found again, or not found. */
const KEY = "test-placeholder";

const thinking = { type: "thinking", thinking: "", signature: "sig" };
const say = (text: string) => ({ type: "text", text });
const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
const call = (name: string, input: unknown, id = "c1") => ({ id, name, input });
/** An error as the SDK builds it from an HTTP answer. Its text stands for something the API quoted back. */
const apiError = (status: number, type: string, text = "the API's own words") => Anthropic.APIError.generate(status, { type: "error", error: { type, message: text } }, text, new Headers());

type Stream = ReturnType<ClaudeClient["beta"]["messages"]["stream"]>;

/**
 * A stand-in for the SDK client. Each request gets the next scripted answer,
 * or fails with the next scripted error. `accepts: false` plays a request
 * that never got as far as an answer beginning.
 */
function fakeClaude(steps: (Record<string, unknown> | Error)[] = [], options: { accepts?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        stream(params) {
          sent.push(structuredClone(params) as unknown as Record<string, unknown>);
          const step = steps.shift() ?? { content: [say("ok")], stop_reason: "end_turn" };
          const heard: { connect?: () => void; text?: (delta: string) => void } = {};
          const stream: Stream = {
            on: ((event: "connect" | "text", listener: (delta: string) => void) => {
              if (event === "connect") heard.connect = () => listener("");
              else heard.text = listener;
              return stream;
            }) as Stream["on"],
            finalMessage: async () => {
              if (options.accepts !== false) heard.connect?.();
              if (step instanceof Error) throw step;
              for (const block of (step.content ?? []) as { type: string; text?: string }[]) if (block.type === "text") heard.text?.(block.text ?? "");
              return { model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 5 }, ...step } as unknown as Anthropic.Beta.BetaMessage;
            },
          };
          return stream;
        },
      },
    },
  };
  return { client, sent };
}

/** A model that answers what the test scripted, or fails with a scripted error, and records what it was sent. */
class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly role: ProviderRole;
  readonly location: "local" | "cloud";
  readonly model: string;
  readonly requests: ChatRequest[] = [];
  private script: (Partial<ChatResponse> | Error)[];

  constructor(id: string, location: "local" | "cloud", script: (Partial<ChatResponse> | Error)[] = [], role?: ProviderRole) {
    this.id = id;
    this.role = role ?? (location === "local" ? "local" : "strong");
    this.location = location;
    this.model = `${id}-model`;
    this.script = script;
  }
  async available() {
    return true;
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone({ ...request, onText: undefined }));
    const next = this.script.shift() ?? { text: "ok" };
    if (next instanceof Error) throw next;
    return { text: "", toolCalls: [], stop: next.toolCalls?.length ? "tool_use" : "end", usage: { inputTokens: 1000, outputTokens: 500 }, model: this.model, ...next };
  }
}

/** `cloud: true` stands for an owner who has switched cloud models on. */
async function setup(providers: ModelProvider[], options: { cloud?: boolean; logged?: string[] } = {}): Promise<{ instance: Instance; helios: Helios }> {
  const instance = track(await openInstance({ dataDir: tempDir() }));
  if (options.cloud) instance.config.ai.cloud.allowed = true;
  const logged = options.logged;
  const log = logged ? { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) } : silentLogger;
  return { instance, helios: new Helios({ instance, providers, bus: new EventBus(), log }) };
}

const egress = (instance: Instance) =>
  instance.db.prepare("SELECT provider, outcome, cost_micros AS cost, estimated FROM egress_log ORDER BY at, rowid").all() as { provider: string; outcome: string; cost: number; estimated: number }[];
const roles = (instance: Instance) => (instance.db.prepare("SELECT role FROM messages ORDER BY seq").all() as { role: string }[]).map((row) => row.role);
const strongCloud = (script: (Partial<ChatResponse> | Error)[] = []) => new ScriptedProvider("cloud", "cloud", script, "strong");
const localModel = (script: (Partial<ChatResponse> | Error)[] = []) => new ScriptedProvider("local", "local", script);

describe("the key for Claude", () => {
  it("counts only ANTHROPIC_API_KEY, and says what is wrong with a value that cannot be used", async () => {
    expect(readClaudeKey({ ANTHROPIC_API_KEY: `  ${KEY}\n` })).toEqual({ key: KEY });
    expect(readClaudeKey({})).toEqual({ problem: expect.stringContaining("no API key is set") });
    expect(readClaudeKey({ ANTHROPIC_API_KEY: "   " })).toEqual({ problem: expect.stringContaining("no API key is set") });
    // Other credentials the SDK would take by itself do not count: nobody set them up for HELIOS.
    expect(readClaudeKey({ ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_PROFILE: "default" })).toEqual({ problem: expect.stringContaining("no API key is set") });
    expect(readClaudeKey({ ANTHROPIC_API_KEY: "two words" })).toEqual({ problem: expect.stringContaining("a space or a line break") });
    expect(readClaudeKey({ ANTHROPIC_API_KEY: "sk-ant-admin-placeholder" })).toEqual({ problem: expect.stringContaining("Admin key") });
    expect(readClaudeKey({ ANTHROPIC_API_KEY: "sk-ant-oat-placeholder" })).toEqual({ problem: expect.stringContaining("Claude subscription") });

    const provider = (env: NodeJS.ProcessEnv) => new ClaudeProvider({ model: "claude-sonnet-5-5", env });
    expect(await provider({ ANTHROPIC_API_KEY: KEY }).available()).toBe(true);
    expect(await provider({ ANTHROPIC_AUTH_TOKEN: KEY }).available()).toBe(false);
    expect(await provider({ ANTHROPIC_API_KEY: "sk-ant-admin-placeholder" }).available()).toBe(false);
    // What it says about itself names the service and the problem, and never the key.
    expect(provider({ ANTHROPIC_API_KEY: KEY }).describe()).toEqual({ service: "Anthropic", problem: null });
    expect(JSON.stringify(provider({ ANTHROPIC_API_KEY: "sk-ant-admin-placeholder" }).describe())).not.toContain("placeholder");
  });

  it("is handed to the SDK with everything else the SDK would otherwise pick up by itself", async () => {
    const { client } = fakeClaude();
    const made: ClientOptions[] = [];
    const provider = new ClaudeProvider({
      model: "claude-sonnet-5-5",
      // Things in the surroundings that would redirect or expose a request if the SDK were left to read them.
      env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://elsewhere.example.net", ANTHROPIC_AUTH_TOKEN: "another-placeholder", ANTHROPIC_LOG: "debug" },
      createClient: (options) => {
        made.push(options);
        return client;
      },
    });
    await provider.chat({ system: "", messages: [{ role: "user", text: "Hi" }], tools: [] });
    await provider.chat({ system: "", messages: [{ role: "user", text: "Again" }], tools: [] });
    // Its own key, Anthropic's own address, a limit on waiting and repeating, and no logging of requests. One client for all requests.
    expect(made).toEqual([{ apiKey: KEY, baseURL: ANTHROPIC_API, maxRetries: 1, timeout: 120_000, logLevel: "off" }]);
    expect(ANTHROPIC_API).toBe("https://api.anthropic.com");
  });

  it("goes only to an encrypted address, or to this machine", async () => {
    expect(claudeEndpoint("")).toEqual({ url: ANTHROPIC_API, host: null });
    expect(claudeEndpoint("https://gateway.example.net/claude/")).toEqual({ url: "https://gateway.example.net/claude", host: "gateway.example.net" });
    for (const local of ["http://127.0.0.1:7129", "http://localhost:7129", "http://[::1]:7129"]) expect(claudeEndpoint(local)).toMatchObject({ url: local });
    expect(claudeEndpoint("http://gateway.example.net")).toEqual({ problem: expect.stringContaining("https://") });
    expect(claudeEndpoint("ftp://gateway.example.net")).toEqual({ problem: expect.stringContaining("https://") });
    expect(claudeEndpoint("https://name:word@gateway.example.net")).toEqual({ problem: expect.stringContaining("name or a password") });
    expect(claudeEndpoint("not an address")).toEqual({ problem: expect.stringContaining("cannot be read") });

    // Another address is named wherever the service is named, so the owner sees where conversations go.
    const viaGateway = new ClaudeProvider({ model: "m", env: { ANTHROPIC_API_KEY: KEY }, baseUrl: "https://gateway.example.net" });
    expect(viaGateway.describe()).toEqual({ service: "Anthropic by way of gateway.example.net", problem: null });

    // With an address the key may not be sent to, no client is made and nothing is sent.
    let made = 0;
    const unsafe = new ClaudeProvider({ model: "m", env: { ANTHROPIC_API_KEY: KEY }, baseUrl: "http://gateway.example.net", createClient: () => (made++, fakeClaude().client) });
    expect(await unsafe.available()).toBe(false);
    await expect(unsafe.chat({ system: "", messages: [{ role: "user", text: "Hi" }], tools: [] })).rejects.toMatchObject({ name: "ProviderError", kind: "invalid" });
    const noKey = new ClaudeProvider({ model: "m", env: {}, createClient: () => (made++, fakeClaude().client) });
    await expect(noKey.chat({ system: "", messages: [{ role: "user", text: "Hi" }], tools: [] })).rejects.toMatchObject({ name: "ProviderError", kind: "auth" });
    expect(made).toBe(0);
  });

  it("is not in anything HELIOS says, logs or stores, also when an error repeats it", async () => {
    // The API turns the key down, and its error text quotes the key back.
    const refused = fakeClaude([apiError(401, "authentication_error", `invalid x-api-key: ${KEY}`)]);
    const claude = new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, createClient: () => refused.client });
    const logged: string[] = [];
    const { instance, helios } = await setup([localModel([{ text: "from this machine" }]), claude], { cloud: true, logged });

    const turn = await helios.handleMessage("Think hard about this plan");
    expect(refused.sent).toHaveLength(1);
    expect(turn.messages.map((message) => message.text)).toEqual([
      "Think hard about this plan",
      "claude-sonnet-5-5 could not answer. Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in the .env file.",
      "from this machine",
    ]);

    const stored = ["messages", "egress_log", "audit_log", "approvals", "cloud_reservations", "meta"].map((table) => JSON.stringify(instance.db.prepare(`SELECT * FROM ${table}`).all()));
    const everything = [...logged, ...stored, JSON.stringify(turn), JSON.stringify(await helios.status()), JSON.stringify(instance.config)].join("\n");
    expect(everything).not.toContain(KEY);
    expect(logged.join("\n")).toContain("Model claude-strong failed (auth).");
    expect(logged.join("\n")).not.toContain("Think hard"); // and nothing that was typed
  });
});

describe("what is read out of Claude's answer", () => {
  it("after one model handed over to another, runs only what the second asked for, and counts both", async () => {
    // The first model wrote a tool request and some words, then declined. The API let another model finish the answer.
    const handOver = { type: "fallback", from: { model: "claude-sonnet-5-5" }, to: { model: "claude-sonnet-5" }, trigger: { type: "refusal", category: "cyber" } };
    const content = [thinking, use("t1", "add_task", { title: "From the model that declined" }), say("Let me look. "), handOver, thinking, say("Here it is."), use("t2", "get_overview")];
    const usage = {
      input_tokens: 400,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iterations: [
        { type: "message", model: "claude-sonnet-5-5", input_tokens: 400, output_tokens: 20, cache_creation_input_tokens: 400, cache_read_input_tokens: 0 },
        { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 400, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ],
    };
    const { client } = fakeClaude([{ model: "claude-sonnet-5", content, stop_reason: "tool_use", usage }]);
    const response = await new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", client }).chat({ system: "", messages: [{ role: "user", text: "Hi" }], tools: [] });

    expect(response.toolCalls).toEqual([{ id: "t2", name: "get_overview", input: {} }]); // never the first model's request
    expect(response).toMatchObject({ text: "Let me look. Here it is.", stop: "tool_use", model: "claude-sonnet-5" });
    // Both attempts are on the bill, each under its own model.
    expect(response.usage.attempts).toEqual([
      { model: "claude-sonnet-5-5", inputTokens: 800, cacheWriteTokens: 400, outputTokens: 20 },
      { model: "claude-sonnet-5", inputTokens: 400, cacheWriteTokens: 0, outputTokens: 30 },
    ]);

    // Sent back in the same turn: the first model's reasoning and request are left out, its words and the hand-over mark stay in place.
    const messages: ChatMessage[] = [
      { role: "user", text: "Hi" },
      { role: "assistant", text: response.text, toolCalls: response.toolCalls, provider: "claude-strong", raw: response.raw },
      { role: "tool", results: [{ id: "t2", name: "get_overview", output: "{}", isError: false }] },
    ];
    const sentBack = toClaudeMessages(messages, "claude-strong");
    expect(sentBack[1]).toEqual({ role: "assistant", content: [say("Let me look. "), handOver, thinking, say("Here it is."), use("t2", "get_overview")] });
    expect(sentBack[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "{}", is_error: false }] });
  });

  it("counts an ordinary answer once, and never runs requests from an answer that did not end in them", async () => {
    const ordinary = fakeClaude([{ content: [say("Hello")], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, iterations: [{ type: "message", model: "claude-sonnet-5-5", input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 }] } }]);
    const answer = await new ClaudeProvider({ model: "claude-sonnet-5-5", client: ordinary.client }).chat({ system: "", messages: [{ role: "user", text: "Hi" }], tools: [] });
    expect(answer.usage).toEqual({ inputTokens: 100, cacheWriteTokens: 0, outputTokens: 5 }); // no list of attempts when there was one

    for (const [reason, stop] of [["max_tokens", "max_tokens"], ["model_context_window_exceeded", "max_tokens"], ["refusal", "refusal"], ["pause_turn", "end"], ["end_turn", "end"]] as const) {
      const { client } = fakeClaude([{ content: [use("t1", "add_task", { title: "half" })], stop_reason: reason }]);
      expect(await new ClaudeProvider({ model: "m", client }).chat({ system: "", messages: [{ role: "user", text: "Hi" }], tools: [] }), reason).toMatchObject({ stop, toolCalls: [] });
    }
  });

  it("asks once more without its earlier reasoning when the API turns the request down, and repeats nothing else", async () => {
    const messages: ChatMessage[] = [
      { role: "user", text: "What is due?" },
      { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "get_overview", input: {} }], provider: "claude-strong", raw: [thinking, use("t1", "get_overview")] },
      { role: "tool", results: [{ id: "t1", name: "get_overview", output: "{}", isError: false }] },
    ];
    const request = { system: "You are HELIOS.", messages, tools: [] };
    const turnedDown = () => apiError(400, "invalid_request_error", "messages.1.content.0: Invalid `signature` in `thinking` block.");
    const provider = (client: ClaudeClient) => new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", client });

    // Turned down with reasoning in it: asked again without, and that answer is used.
    const recovered = fakeClaude([turnedDown(), { content: [say("Nothing is due.")], stop_reason: "end_turn" }]);
    expect(await provider(recovered.client).chat(request)).toMatchObject({ text: "Nothing is due.", stop: "end" });
    expect(recovered.sent).toHaveLength(2);
    expect(JSON.stringify(recovered.sent[0]?.messages)).toContain('"thinking"');
    expect(recovered.sent[1]?.messages).toEqual([
      { role: "user", content: "What is due?" },
      { role: "assistant", content: [use("t1", "get_overview")] }, // the request and its result stay; only the reasoning is gone
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}", is_error: false }] },
    ]);

    // Turned down again: that is the end, after two requests, not three.
    const stillDown = fakeClaude([turnedDown(), turnedDown(), { content: [say("never reached")], stop_reason: "end_turn" }]);
    await expect(provider(stillDown.client).chat(request)).rejects.toMatchObject({ kind: "invalid" });
    expect(stillDown.sent).toHaveLength(2);

    // Nothing to leave out: not asked again.
    const plain = fakeClaude([turnedDown()]);
    await expect(provider(plain.client).chat({ system: "", messages: [{ role: "user", text: "Hi" }], tools: [] })).rejects.toMatchObject({ kind: "invalid" });
    expect(plain.sent).toHaveLength(1);

    // Any other failure is not repeated here either: an overloaded service, an answer that cannot be read.
    for (const failure of [apiError(529, "overloaded_error"), new SyntaxError("Unexpected end of JSON input")]) {
      const once = fakeClaude([failure, { content: [say("never reached")], stop_reason: "end_turn" }]);
      await expect(provider(once.client).chat(request)).rejects.toBeInstanceOf(ProviderError);
      expect(once.sent).toHaveLength(1);
    }
  });
});

describe("when Claude cannot answer", () => {
  it("says what went wrong in its own words, for each kind of failure", () => {
    const quoted = "the owner's private question about the mortgage";
    const cases: [unknown, string, RegExp][] = [
      [apiError(401, "authentication_error", quoted), "auth", /did not accept the API key/],
      [apiError(402, "billing_error", quoted), "billing", /billing problem.*subscription does not include/],
      [apiError(403, "permission_error", quoted), "permission", /not allowed to use claude-sonnet-5-5/],
      [apiError(404, "not_found_error", quoted), "model", /does not offer a model called claude-sonnet-5-5/],
      [apiError(429, "rate_limit_error", quoted), "rate_limit", /limiting requests/],
      [apiError(413, "request_too_large", quoted), "invalid", /too large/],
      [apiError(400, "invalid_request_error", quoted), "invalid", /did not accept the request/],
      [apiError(500, "api_error", quoted), "unavailable", /overloaded or having trouble/],
      [apiError(529, "overloaded_error", quoted), "unavailable", /overloaded or having trouble/],
      [new Anthropic.APIConnectionTimeoutError({ message: quoted }), "timeout", /did not answer in time/],
      [new Anthropic.APIConnectionError({ message: quoted }), "network", /could not be reached/],
      [new Anthropic.APIUserAbortError({ message: quoted }), "aborted", /was stopped/],
      [new SyntaxError(quoted), "malformed", /could not be read/],
    ];
    for (const [error, kind, says] of cases) {
      const told = toProviderError(error, "claude-sonnet-5-5", false);
      expect(told, kind).toMatchObject({ name: "ProviderError", kind });
      expect(told.message, kind).toMatch(says);
      // Nothing of the provider's own text is passed on: it can quote the request.
      expect(told.message, kind).not.toContain("mortgage");
    }
    // A typed failure passes through as it is.
    const known = new ProviderError("billing", "Already in words for the owner.");
    expect(toProviderError(known, "m", true)).toBe(known);
  });

  it("knows which failures can still cost money", async () => {
    // A request that was turned away costs nothing, whenever it happens.
    for (const refusedOutright of [apiError(401, "authentication_error"), apiError(429, "rate_limit_error"), apiError(400, "invalid_request_error")]) {
      expect(toProviderError(refusedOutright, "m", true).billable).toBe(false);
    }
    // One that failed before Anthropic began to answer costs nothing either. After that it may.
    for (const failure of [new Anthropic.APIConnectionError({ message: "x" }), new Anthropic.APIConnectionTimeoutError(), apiError(529, "overloaded_error")]) {
      expect(toProviderError(failure, "m", false).billable).toBe(false);
      expect(toProviderError(failure, "m", true).billable).toBe(true);
    }
    // An answer that arrived and could not be read was certainly produced.
    expect(toProviderError(new SyntaxError("x"), "m", false).billable).toBe(true);

    // The provider itself tells the two apart by whether the answer had begun.
    const dropped = () => new Anthropic.APIConnectionError({ message: "socket hang up" });
    const request = { system: "", messages: [{ role: "user" as const, text: "Hi" }], tools: [] };
    await expect(new ClaudeProvider({ model: "m", client: fakeClaude([dropped()], { accepts: false }).client }).chat(request)).rejects.toMatchObject({ kind: "network", billable: false, message: expect.stringContaining("could not be reached") });
    await expect(new ClaudeProvider({ model: "m", client: fakeClaude([dropped()]).client }).chat(request)).rejects.toMatchObject({ kind: "network", billable: true, message: expect.stringContaining("broke off") });
  });
});

describe("the real SDK, talking to a stand-in for Anthropic's service on this machine", () => {
  // The tests above replace the SDK's client. These keep the SDK and replace
  // the service: a small web server on this machine that answers the way the
  // Messages API does. They show that the provider drives the real SDK
  // correctly. They still do not show that Anthropic accepts the request.

  type Reply = (response: http.ServerResponse) => void;
  type Received = { method: string; path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

  /** The stand-in services a test started. Each is closed when its test is over. */
  const running: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of running.splice(0)) await close();
  });

  async function standInService(replies: Reply[]): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
    const received: Received[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> });
        const reply = replies.shift();
        if (reply) reply(response);
        else response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    running.push(close);
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, close };
  }
  /** An answer streamed the way the Messages API streams one. */
  const streams =
    (...events: Record<string, unknown>[]): Reply =>
    (response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const event of events) response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    };
  /** An error answered the way the Messages API answers one. Its text quotes the key back, as a careless service might. */
  const refuses =
    (status: number, type: string): Reply =>
    (response) => {
      response.writeHead(status, { "content-type": "application/json", "retry-after-ms": "1" });
      response.end(JSON.stringify({ type: "error", error: { type, message: `problem with ${KEY}` } }));
    };
  const start = (usage: Record<string, unknown> = { input_tokens: 25, output_tokens: 1 }) => ({
    type: "message_start",
    message: { id: "msg_standin", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage },
  });
  const textBlock = (index: number, ...pieces: string[]) => [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...pieces.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
    { type: "content_block_stop", index },
  ];
  const toolBlock = (index: number, id: string, name: string, ...jsonPieces: string[]) => [
    { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } },
    ...jsonPieces.map((partial_json) => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
    { type: "content_block_stop", index },
  ];
  const end = (stop_reason: string, output_tokens: number) => [{ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } }, { type: "message_stop" }];
  const claudeAt = (url: string, role: "strong" | "light" = "strong") =>
    new ClaudeProvider({ role, model: role === "strong" ? "claude-sonnet-5-5" : "claude-haiku-5-5", effort: "low", maxOutputTokens: 2000, baseUrl: url, env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://elsewhere.example.net" } });
  const request = (onText?: (delta: string) => void): ChatRequest => ({
    system: "You are HELIOS.",
    messages: [{ role: "user", text: "What is due?" }],
    tools: [{ name: "add_task", description: "Adds a task.", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }],
    onText,
  });

  it("sends one streamed request with the key in one header only, and reads the words and the tool request back", async () => {
    const service = await standInService([streams(start({ input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 75 }), ...textBlock(0, "Let me ", "add that."), ...toolBlock(1, "toolu_standin", "add_task", '{"title": "Call', ' the bank"}'), ...end("tool_use", 40))]);
    const heard: string[] = [];
    const answer = await claudeAt(service.url).chat(request((delta) => heard.push(delta)));

    expect(answer).toMatchObject({ text: "Let me add that.", stop: "tool_use", model: "claude-sonnet-5-5", toolCalls: [{ id: "toolu_standin", name: "add_task", input: { title: "Call the bank" } }] });
    expect(answer.usage).toEqual({ inputTokens: 100, cacheWriteTokens: 0, outputTokens: 40 });
    expect(heard.join("")).toBe("Let me add that."); // the words arrive while they are written

    expect(service.received).toHaveLength(1);
    const [sent] = service.received;
    expect(sent).toMatchObject({ method: "POST", path: expect.stringMatching(/^\/v1\/messages(\?|$)/) });
    // The key travels in the one header the SDK puts it in, and nowhere else in the request.
    expect(Object.entries(sent?.headers ?? {}).filter(([, value]) => String(value).includes(KEY)).map(([name]) => name)).toEqual(["authorization"]);
    expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(`${sent?.path} ${JSON.stringify(sent?.body)}`).not.toContain(KEY);
    expect(String(sent?.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(sent?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 2000,
      stream: true,
      system: "You are HELIOS.",
      messages: [{ role: "user", content: "What is due?" }],
      output_config: { effort: "low" },
      cache_control: { type: "ephemeral" },
      fallbacks: "default",
      tools: [{ name: "add_task", eager_input_streaming: true }],
    });
    // Nothing HELIOS does not mean to send: no forced tool, no sampling settings, no thinking setting of its own.
    for (const field of ["tool_choice", "temperature", "top_p", "top_k", "thinking", "metadata"]) expect(sent?.body, field).not.toHaveProperty(field);
  });

  it("does not send the fallback option for the light model", async () => {
    const service = await standInService([streams(start(), ...textBlock(0, "ok"), ...end("end_turn", 3))]);
    expect(await claudeAt(service.url, "light").chat(request())).toMatchObject({ text: "ok", stop: "end" });
    expect(service.received[0]?.body).toMatchObject({ model: "claude-haiku-5-5" });
    expect(service.received[0]?.body).not.toHaveProperty("fallbacks");
    expect(service.received[0]?.headers["anthropic-beta"]).toBeUndefined();
  });

  it("does not run a tool request whose input was cut off or is not valid JSON", async () => {
    // Cut off at the length limit in the middle of the input: the SDK reads half an object, and the stop reason says it is no request.
    const cut = await standInService([streams(start(), ...toolBlock(0, "toolu_cut", "add_task", '{"title": "Call the'), ...end("max_tokens", 2000))]);
    expect(await claudeAt(cut.url).chat(request())).toMatchObject({ stop: "max_tokens", toolCalls: [] });

    // Not JSON at all: an answer that cannot be read, which was produced and so may be on the bill. It is not asked for again.
    const garbled = await standInService([streams(start(), ...toolBlock(0, "toolu_bad", "add_task", '{"title": }'), ...end("tool_use", 12)), streams(start(), ...textBlock(0, "never reached"), ...end("end_turn", 3))]);
    await expect(claudeAt(garbled.url).chat(request())).rejects.toMatchObject({ name: "ProviderError", kind: "malformed", billable: true });
    expect(garbled.received).toHaveLength(1);
  });

  it("tells a refused key from an empty account from an overloaded service, and repeats only what may be repeated", async () => {
    // A key that is not accepted: once, never repeated, and the answer's own text (which quotes the key) is not passed on.
    const refused = await standInService([refuses(401, "authentication_error"), streams(start(), ...textBlock(0, "never reached"), ...end("end_turn", 3))]);
    const told = await claudeAt(refused.url).chat(request()).catch((error: unknown) => error as ProviderError);
    expect(told).toMatchObject({ name: "ProviderError", kind: "auth", billable: false });
    expect((told as ProviderError).message).not.toContain(KEY);
    expect(refused.received).toHaveLength(1);

    // An empty account.
    const unpaid = await standInService([refuses(402, "billing_error")]);
    await expect(claudeAt(unpaid.url).chat(request())).rejects.toMatchObject({ kind: "billing", billable: false });

    // An overloaded service is tried once more by the SDK, and then reported. Nothing had begun, so nothing is counted.
    const overloaded = await standInService([refuses(529, "overloaded_error"), refuses(529, "overloaded_error"), streams(start(), ...textBlock(0, "never reached"), ...end("end_turn", 3))]);
    await expect(claudeAt(overloaded.url).chat(request())).rejects.toMatchObject({ kind: "unavailable", billable: false });
    expect(overloaded.received).toHaveLength(2);
    // ...and when the second try works, the owner never hears of the first.
    const recovers = await standInService([refuses(529, "overloaded_error"), streams(start(), ...textBlock(0, "Here now."), ...end("end_turn", 3))]);
    expect(await claudeAt(recovers.url).chat(request())).toMatchObject({ text: "Here now." });
  });

  // Windows takes about two seconds to report that nobody listens at an
  // address, and the SDK tries twice: hence the longer time allowed here.
  it("reports a service that cannot be reached at all, and counts nothing for it", { timeout: 30_000 }, async () => {
    const gone = await standInService([]);
    await gone.close();
    await expect(claudeAt(gone.url).chat(request())).rejects.toMatchObject({ kind: "network", billable: false, message: expect.stringContaining("could not be reached") });
  });

  it("counts an answer that breaks off after it began as possibly billed", async () => {
    // The service starts to answer and then drops the connection in the middle.
    const breaks: Reply = (response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`event: message_start\ndata: ${JSON.stringify(start())}\n\n`);
      response.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
      setTimeout(() => response.destroy(), 20);
    };
    const service = await standInService([breaks, breaks]);
    const failed = await claudeAt(service.url).chat(request()).catch((error: unknown) => error as ProviderError);
    expect(failed).toMatchObject({ name: "ProviderError", billable: true });
    expect(service.received).toHaveLength(1); // an answer that had begun is not asked for a second time
  });
});

describe("cloud models are off until the owner switches them on", () => {
  it("sends nothing with a key alone, and says why the local model answered", async () => {
    expect(defaultConfig().ai.cloud.allowed).toBe(false);

    // A real provider with a key, in a fresh installation. Making a client would be the first step towards sending.
    let made = 0;
    const claude = new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, createClient: () => (made++, fakeClaude().client) });
    const local = localModel([{ text: "from this machine" }, { text: "again from this machine" }]);
    const { instance, helios } = await setup([local, claude]);

    const asked = await helios.handleMessage("Think hard about this: which plan is better?");
    expect(asked.messages.at(-1)).toMatchObject({ text: "from this machine", route: "the stronger model was not used: cloud models are switched off" });
    const long = await helios.handleMessage("Compare the two suppliers and analyse the trade-offs", { conversationId: asked.conversationId });
    expect(long.messages.at(-1)).toMatchObject({ text: "again from this machine", route: "kept local: cloud models are switched off" });
    expect(made).toBe(0);
    expect(egress(instance)).toEqual([]);
    expect((await helios.status()).cloud).toEqual({ enabled: false, ready: false, service: "Anthropic", models: ["claude-sonnet-5-5"], problem: "cloud models are switched off" });
  });

  it("does not take an older settings file's word for it", async () => {
    // Earlier versions had this switch on unless it was turned off, and wrote
    // it into the settings file by themselves, under the name "enabled".
    const dataDir = tempDir();
    writeFileSync(dataPaths(dataDir).configFile, JSON.stringify({ ai: { cloud: { enabled: true, strongModel: "claude-opus-5-5" } }, web: { enabled: true } }));
    const instance = track(await openInstance({ dataDir }));
    expect(instance.config.ai.cloud.allowed).toBe(false);
    // What the owner did set in that file is kept.
    expect(instance.config.ai.cloud.strongModel).toBe("claude-opus-5-5");
    expect(instance.config.web.enabled).toBe(true);

    const cloud = strongCloud([{ text: "must not be asked" }]);
    const helios = new Helios({ instance, providers: [localModel([{ text: "from this machine" }]), cloud], bus: new EventBus(), log: silentLogger });
    expect((await helios.handleMessage("Think hard about this plan")).messages.at(-1)).toMatchObject({ text: "from this machine" });
    expect(cloud.requests).toHaveLength(0);

    // The next time the settings are saved, the old switch is gone from the file.
    saveConfig(instance.paths, instance.config);
    const saved = JSON.parse(readFileSync(instance.paths.configFile, "utf8")) as { ai: { cloud: Record<string, unknown> } };
    expect(saved.ai.cloud).not.toHaveProperty("enabled");
    expect(saved.ai.cloud.allowed).toBe(false);
  });

  it("answers with the reason when there is no local model either", async () => {
    const cloud = strongCloud([{ text: "must not be asked" }]);
    const { helios } = await setup([cloud]);
    const turn = await helios.handleMessage("What is due this week?");
    expect(cloud.requests).toHaveLength(0);
    expect(turn.messages.at(-1)).toMatchObject({ role: "system", text: "Cloud models are switched off, and no local model is running." });
  });

  it("says what is still missing once they are on", async () => {
    const noKey = await setup([new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", env: {} })], { cloud: true });
    expect((await noKey.helios.status()).cloud).toEqual({ enabled: true, ready: false, service: "Anthropic", models: ["claude-sonnet-5-5"], problem: "no API key is set (ANTHROPIC_API_KEY in the .env file)" });

    const ready = await setup([new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY } })], { cloud: true });
    expect((await ready.helios.status()).cloud).toMatchObject({ enabled: true, ready: true, problem: null });
    // With the month's budget used up they are on, and not usable.
    ready.instance.config.ai.cloud.budget.capEur = 0;
    expect((await ready.helios.status()).cloud).toMatchObject({ enabled: true, ready: false, problem: "this month's cloud budget is used up" });
  });

  it("is switched from the screen: off at once, on only with the password", async () => {
    const PASSWORD = "test-only password 1234";
    const HOST = "localhost:7117";
    const instance = track(await openInstance({ dataDir: tempDir() }));
    await setOwnerPassword(instance.db, "owner", PASSWORD);
    const claude = new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY } });
    const { app } = await buildServer({ instance, log: silentLogger, providers: [new StandInProvider(), claude] });
    try {
      const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: HOST, origin: `http://${HOST}` }, payload: { username: "owner", password: PASSWORD } });
      const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
      const send = (method: "GET" | "PUT" | "POST", url: string, body?: object) => app.inject({ method, url, headers: { host: HOST, origin: `http://${HOST}`, cookie }, ...(body ? { payload: body } : {}) });
      const state = async () => (await send("GET", "/api/helios/status")).json<{ cloud: Record<string, unknown>; cloudEnabled: boolean }>();
      const off = { enabled: false, ready: false, service: "Anthropic", models: ["claude-sonnet-5-5"], problem: "cloud models are switched off" };
      const on = { enabled: true, ready: true, service: "Anthropic", models: ["claude-sonnet-5-5"], problem: null };

      // Off in a fresh installation, although a key is there.
      expect(await state()).toMatchObject({ cloud: off, cloudEnabled: false });
      // Turning them on lets conversations leave this machine and can cost money: the password is asked for again.
      expect((await send("PUT", "/api/ai/cloud", { enabled: true })).statusCode).toBe(403);
      expect(instance.config.ai.cloud.allowed).toBe(false);
      expect((await send("POST", "/api/auth/elevate", { password: PASSWORD })).statusCode).toBe(200);
      expect((await send("PUT", "/api/ai/cloud", { enabled: true })).json()).toEqual(on);
      expect(await state()).toMatchObject({ cloud: on, cloudEnabled: true });

      // It is written to the settings file, so it is still on after a restart. The key is not in that file. The change is in the audit log.
      const saved = readFileSync(instance.paths.configFile, "utf8");
      expect((JSON.parse(saved) as { ai: { cloud: { allowed: boolean } } }).ai.cloud.allowed).toBe(true);
      expect(saved).not.toContain(KEY);
      const audited = () => instance.db.prepare("SELECT actor, detail FROM audit_log WHERE action = 'cloud.settings' ORDER BY seq").all() as { actor: string; detail: string }[];
      expect(audited()).toEqual([{ actor: "owner", detail: JSON.stringify({ enabled: true }) }]);

      // Turning them off never needs the password, and works at once.
      instance.db.prepare("UPDATE sessions SET elevated_until = NULL").run();
      expect((await send("PUT", "/api/ai/cloud", { enabled: false })).json()).toEqual(off);
      expect((JSON.parse(readFileSync(instance.paths.configFile, "utf8")) as { ai: { cloud: { allowed: boolean } } }).ai.cloud.allowed).toBe(false);
      expect(audited()).toHaveLength(2);
      // Saying "off" to what is off changes nothing and is not written down again.
      expect((await send("PUT", "/api/ai/cloud", { enabled: false })).statusCode).toBe(200);
      expect(audited()).toHaveLength(2);

      // Only a plain yes or no is accepted, only from the owner's own page, and only with a login.
      expect((await send("PUT", "/api/ai/cloud", { enabled: "yes" })).statusCode).toBe(400);
      expect((await send("PUT", "/api/ai/cloud", {})).statusCode).toBe(400);
      expect((await app.inject({ method: "PUT", url: "/api/ai/cloud", headers: { host: HOST, origin: `http://${HOST}` }, payload: { enabled: true } })).statusCode).toBe(401);
      expect((await app.inject({ method: "PUT", url: "/api/ai/cloud", headers: { host: HOST, origin: "http://other.example.net", cookie }, payload: { enabled: true } })).statusCode).toBe(403);
      expect(instance.config.ai.cloud.allowed).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("a cloud model's tool requests", () => {
  it("pass the same gate as every other model's", async () => {
    const cloud = strongCloud([
      { toolCalls: [call("add_task", { title: "Asked for by the cloud model", area: "inbox" }, "c1"), call("delete_everything", {}, "c2"), call("add_task", { title: 12 }, "c3")] },
      { text: "I have asked you to confirm the task." },
    ]);
    const { instance, helios } = await setup([cloud], { cloud: true });

    const turn = await helios.handleMessage("Think hard, then add that task");
    // The change waits for the owner; the tool that does not exist and the malformed request are turned away. Nothing has run.
    expect(turn.approvals).toHaveLength(1);
    expect(turn.approvals[0]).toMatchObject({ kind: "tool", tier: 1, status: "pending" });
    expect(taskTitles(instance)).toEqual([]);
    const shown = cloud.requests[1]?.messages.at(-1) as { role: "tool"; results: { id: string; output: string; isError: boolean }[] };
    expect(shown.results.map((result) => [result.id, result.isError])).toEqual([["c1", false], ["c2", true], ["c3", true]]);
    expect(shown.results[0]?.output).toContain("waiting_for_owner");
    expect(shown.results[1]?.output).toContain("There is no tool named");
    expect(shown.results[2]?.output).toContain("Invalid input");

    // The owner's yes runs exactly what was asked for, once.
    await helios.decide(turn.approvals[0]?.id as string, "approve", null);
    expect(taskTitles(instance)).toEqual(["Asked for by the cloud model"]);
  });
});

describe("when a cloud model fails in the middle of a turn", () => {
  const brokeOff = () => new ProviderError("network", "The connection to Anthropic broke off in the middle of the answer.", true);

  it("says why, lets another model answer, and counts nothing for a request that was turned away", async () => {
    const cloud = strongCloud([new ProviderError("billing", "Anthropic reports a billing problem. The API account may have no credit left; a Claude subscription does not include any.")]);
    const local = localModel([{ text: "from this machine" }, { text: "and again" }]);
    const { instance, helios } = await setup([local, cloud], { cloud: true });

    const turn = await helios.handleMessage("Think hard about this plan");
    expect(turn.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Think hard about this plan"],
      ["system", "cloud-model could not answer. Anthropic reports a billing problem. The API account may have no credit left; a Claude subscription does not include any."],
      ["assistant", "from this machine"],
    ]);
    expect(turn.messages.at(-1)?.route).toBe("the stronger model was not used: the cloud model could not answer");
    expect(egress(instance)).toEqual([{ provider: "cloud", outcome: "failed", cost: 0, estimated: 0 }]);
    expect(budgetStatus(instance.db, instance.config).spentEur).toBe(0);
    expect(instance.db.prepare("SELECT COUNT(*) AS n FROM cloud_reservations").get()).toEqual({ n: 0 }); // nothing stays set aside
  });

  it("leaves no remark when the request was only stopped", async () => {
    const cloud = strongCloud([new ProviderError("aborted", "The request to Claude was stopped.")]);
    const { helios } = await setup([localModel([{ text: "from this machine" }]), cloud], { cloud: true });
    const turn = await helios.handleMessage("Think hard about this plan");
    expect(turn.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("counts a call that broke off after the answer had begun as spent, at the most it could have cost", async () => {
    for (const failure of [brokeOff(), new Error("something nobody foresaw")]) {
      const cloud = strongCloud([failure]);
      const { instance, helios } = await setup([localModel([{ text: "from this machine" }]), cloud], { cloud: true });
      await helios.handleMessage("Think hard about this plan");
      const [row] = egress(instance);
      expect(row).toMatchObject({ provider: "cloud", outcome: "sent", estimated: 1 });
      expect(row?.cost).toBeGreaterThan(0);
      expect(budgetStatus(instance.db, instance.config).spentEur).toBeGreaterThan(0);
      expect(instance.db.prepare("SELECT COUNT(*) AS n FROM cloud_reservations").get()).toEqual({ n: 0 });
    }
  });

  it("does not repeat a change that already ran", async () => {
    const task = { title: "Call the bank", area: "inbox" };
    // The cloud model adds the task, then its connection breaks. The local model takes over and asks for the same task again.
    const cloud = strongCloud([{ toolCalls: [call("add_task", task, "c1")] }, brokeOff()]);
    const local = localModel([{ toolCalls: [call("add_task", task, "l1")] }, { text: "I have asked you to confirm." }]);
    const { instance, helios } = await setup([local, cloud], { cloud: true });
    instance.config.ai.autoApproveTier1 = true; // small changes run without asking

    const turn = await helios.handleMessage("Think hard, then add a task to call the bank");
    // The first request ran at once, as the owner's settings allow. The repeated one did not: it waits for the owner.
    expect(taskTitles(instance)).toEqual(["Call the bank"]);
    expect(turn.approvals).toHaveLength(1);
    expect(turn.approvals[0]).toMatchObject({ kind: "tool", tier: 1, status: "pending" });
    expect(instance.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.run'").get()).toEqual({ n: 1 });

    // The model that took over was shown what had already been done, and its result.
    const seen = local.requests[0]?.messages ?? [];
    expect(seen.find((message) => message.role === "assistant" && message.toolCalls.length > 0)).toMatchObject({ toolCalls: [{ id: "c1", name: "add_task" }], provider: "cloud" });
    expect(seen.find((message) => message.role === "tool")).toMatchObject({ results: [{ id: "c1", isError: false }] });
    expect(turn.messages.map((message) => message.role)).toEqual(["user", "system", "assistant"]);

    // Without a failure, the same setting still lets a small change run by itself.
    const calm = await setup([strongCloud([{ toolCalls: [call("add_task", task, "c1")] }, { text: "Added." }])], { cloud: true });
    calm.instance.config.ai.autoApproveTier1 = true;
    expect((await calm.helios.handleMessage("Think hard, then add a task to call the bank")).approvals).toEqual([]);
    expect(taskTitles(calm.instance)).toEqual(["Call the bank"]);
  });
});

describe("what a turn leaves in the transcript", () => {
  /** Prices that make one scripted call cost a little, so the warning level can be set just below it. */
  function cheapPrices(instance: Instance): void {
    const { cloud } = instance.config.ai;
    cloud.pricePerMTok["cloud-model"] = { input: 1, output: 10 };
    cloud.maxOutputTokens.strong = 1000;
    cloud.budget.taxAllowance = 0;
  }

  it("never puts the budget warning between a tool request and its result", async () => {
    const cloud = strongCloud([{ toolCalls: [call("list_tasks", { show: "open" }, "c1")] }, { text: "Nothing is open." }]);
    const { instance, helios } = await setup([cloud], { cloud: true });
    cheapPrices(instance);
    instance.config.ai.cloud.budget.warnEur = 0.005; // passed by the first call of the turn

    const turn = await helios.handleMessage("Think hard: what is open?");
    // (The first row is the hidden note that tells the model today's date.)
    expect(roles(instance)).toEqual(["system", "user", "assistant", "tool", "system", "assistant"]);
    expect(turn.messages.map((message) => message.text).join(" ")).toMatch(/reached €0.005 of the €20 limit/);
    // On its second step the model is shown its own request together with the result, so it has no reason to ask again.
    const second = cloud.requests[1]?.messages ?? [];
    expect(second.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(second[1]).toMatchObject({ toolCalls: [{ id: "c1", name: "list_tasks" }] });
    expect(second[2]).toMatchObject({ results: [{ id: "c1", isError: false }] });
    expect(instance.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.run'").get()).toEqual({ n: 1 });
  });

  it("gives a turn that goes on after an approval the same beginning it had before", async () => {
    // A conversation longer than the part a model is shown, so that the beginning of that part could move.
    const earlier = Array.from({ length: 24 }, (_, index) => ({ text: `Answer ${index + 1}` }));
    const cloud = strongCloud([...earlier, { toolCalls: [call("get_money_summary", { month: "2026-11" }, "c1")] }, { text: "You made one sale." }]);
    const { helios } = await setup([cloud], { cloud: true });
    let conversationId: string | undefined;
    for (let index = 0; index < earlier.length; index++) ({ conversationId } = await helios.handleMessage(`Question ${index + 1}`, { conversationId }));

    // Money figures are sensitive: the turn stops and asks before it sends them on.
    const held = await helios.handleMessage("How did the shop do this month?", { conversationId });
    expect(held.approvals[0]).toMatchObject({ kind: "cloud_egress", status: "pending" });
    const before = cloud.requests.at(-1)?.messages ?? [];

    await helios.decide(held.approvals[0]?.id as string, "approve", null);
    const after = cloud.requests.at(-1)?.messages ?? [];
    expect(after.length).toBeGreaterThan(before.length);
    // Everything the model was shown before is still there, unchanged and in the same place.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before[0]).toMatchObject({ role: "user" });
    expect((before[0] as { text: string }).text).not.toContain("Question 1\n"); // the view really does not reach back to the start
  });

  it("writes down the owner's yes before the approved action runs, so it cannot run twice", async () => {
    const model = localModel([{ toolCalls: [call("add_task", { title: "Approved once", area: "inbox" })] }, { text: "Waiting for your yes." }]);
    const { instance, helios } = await setup([model]);
    const turn = await helios.handleMessage("Add a task");
    const id = turn.approvals[0]?.id as string;

    // A note taken by the database itself, at the moment the task is written: what did the approval say then?
    instance.db.prepare("CREATE TEMP TABLE seen (status TEXT)").run();
    instance.db.prepare(`CREATE TEMP TRIGGER seen_at_the_write AFTER INSERT ON tasks BEGIN INSERT INTO seen SELECT status FROM approvals WHERE id = '${id}'; END`).run();

    await helios.decide(id, "approve", null);
    expect(instance.db.prepare("SELECT status FROM seen").all()).toEqual([{ status: "approved" }]);
    expect(instance.db.prepare("SELECT status, result FROM approvals WHERE id = ?").get(id)).toMatchObject({ status: "approved", result: expect.stringContaining("Approved once") });
    await expect(helios.decide(id, "approve", null)).rejects.toMatchObject({ status: 409 });
    expect(taskTitles(instance)).toEqual(["Approved once"]);
  });

  it("says when an answer was cut off at its length limit", async () => {
    const { helios } = await setup([localModel([{ text: "This is where it", stop: "max_tokens" }])]);
    const turn = await helios.handleMessage("Explain it");
    expect(turn.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Explain it"],
      ["assistant", "This is where it"],
      ["system", "That answer was cut off at its length limit."],
    ]);
  });
});
