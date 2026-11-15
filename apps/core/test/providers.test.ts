import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { type ClaudeClient, ClaudeProvider, toClaudeMessages } from "../src/ai/claude.ts";
import { OllamaProvider } from "../src/ai/ollama.ts";
import { toolSpecs } from "../src/ai/tools.ts";
import type { ChatMessage } from "../src/ai/types.ts";

// These tests check how conversations are translated to and from each
// provider's format, using fakes. They do NOT prove the real services
// accept the requests: no key and no local model exist on this machine.

const thinking = { type: "thinking", thinking: "", signature: "sig" };
const say = (text: string) => ({ type: "text", text });
const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });

function fakeClaude(answer: Record<string, unknown>) {
  const sent: Record<string, unknown>[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        stream(params) {
          sent.push(params as unknown as Record<string, unknown>);
          return {
            on(_event, listener) {
              listener("Hel");
              listener("lo");
              return this;
            },
            finalMessage: async () => ({ model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 }, ...answer }) as unknown as Anthropic.Beta.BetaMessage,
          };
        },
      },
    },
  };
  return { client, sent };
}

describe("Claude", () => {
  it("is only available once a key exists", async () => {
    expect(await new ClaudeProvider({ model: "claude-opus-5-5", env: {} }).available()).toBe(false);
    expect(await new ClaudeProvider({ model: "claude-opus-5-5", env: { ANTHROPIC_API_KEY: "test-placeholder" } }).available()).toBe(true);
  });

  it("replays the current turn exactly and earlier turns without their reasoning", () => {
    const earlier = [thinking, say("Earlier answer")];
    const current = [thinking, use("t2", "get_overview")];
    const messages: ChatMessage[] = [
      { role: "user", text: "First" },
      { role: "assistant", text: "Earlier answer", toolCalls: [], provider: "claude-strong", raw: earlier },
      { role: "user", text: "Second" },
      { role: "assistant", text: "", toolCalls: [{ id: "t2", name: "get_overview", input: {} }], provider: "claude-strong", raw: current },
      { role: "tool", results: [{ id: "t2", name: "get_overview", output: "{}", isError: false }] },
    ];
    const out = toClaudeMessages(messages, "claude-strong");
    expect(out[1]).toEqual({ role: "assistant", content: [say("Earlier answer")] });
    // The other Claude model must not be handed this model's reasoning blocks.
    expect(toClaudeMessages(messages, "claude-light")[3]).toEqual({ role: "assistant", content: [use("t2", "get_overview")] });
    expect(out[3]).toEqual({ role: "assistant", content: current }); // byte for byte, reasoning included
    expect(out[4]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "{}", is_error: false }] });
  });

  it("rebuilds turns another model answered, and never sends an empty turn", () => {
    const out = toClaudeMessages([
      { role: "user", text: "Hi" },
      { role: "assistant", text: "", toolCalls: [{ id: "standin-1", name: "list_tasks", input: { show: "open" } }], provider: "standin" },
      { role: "tool", results: [{ id: "standin-1", name: "list_tasks", output: "[]", isError: false }] },
      { role: "assistant", text: "", toolCalls: [], provider: "ollama" },
    ], "claude-strong");
    expect(out[1]).toEqual({ role: "assistant", content: [use("standin-1", "list_tasks", { show: "open" })] });
    expect(out[3]).toEqual({ role: "assistant", content: [say("(no reply)")] });
  });

  it("sends the request the way the SDK documents it and reads the answer", async () => {
    const content = [thinking, say("Hello"), use("t1", "get_overview")];
    const { client, sent } = fakeClaude({ content, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } });
    const heard: string[] = [];
    const provider = new ClaudeProvider({ role: "strong", model: "claude-sonnet-5-5", effort: "low", maxOutputTokens: 4000, client });
    const response = await provider.chat({ system: "You are HELIOS.", messages: [{ role: "user", text: "Hi" }], tools: toolSpecs(), onText: (delta) => heard.push(delta) });

    expect(sent[0]).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 4000, system: "You are HELIOS.", output_config: { effort: "low" }, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    const tools = sent[0]?.tools as { name: string; input_schema: { type: string }; eager_input_streaming: boolean }[];
    expect(tools.find((tool) => tool.name === "add_task")).toMatchObject({ input_schema: { type: "object" }, eager_input_streaming: true });

    expect(response).toMatchObject({ text: "Hello", stop: "tool_use", toolCalls: [{ id: "t1", name: "get_overview" }], usage: { inputTokens: 100, outputTokens: 5 } });
    expect(response.raw).toBe(content);
    expect(heard.join("")).toBe("Hello");
  });

  it("does not send the fallback option to the light model, which does not support it", async () => {
    const { client, sent } = fakeClaude({ content: [say("ok")], stop_reason: "end_turn" });
    const light = new ClaudeProvider({ role: "light", model: "claude-haiku-5-5", effort: "low", maxOutputTokens: 2000, client });
    await light.chat({ system: "", messages: [{ role: "user", text: "Classify this" }], tools: [] });
    expect(light.id).toBe("claude-light");
    expect(sent[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 2000 });
    expect(sent[0]).not.toHaveProperty("fallbacks");
    expect(sent[0]).not.toHaveProperty("betas");
  });

  it("never runs tool requests from an answer that was cut off or declined", async () => {
    const cut = fakeClaude({ content: [use("t1", "add_task", { title: "half" })], stop_reason: "max_tokens" });
    expect(await new ClaudeProvider({ model: "m", client: cut.client }).chat({ system: "", messages: [], tools: [] })).toMatchObject({ stop: "max_tokens", toolCalls: [] });
    const declined = fakeClaude({ content: [], stop_reason: "refusal" });
    expect(await new ClaudeProvider({ model: "m", client: declined.client }).chat({ system: "", messages: [], tools: [] })).toMatchObject({ stop: "refusal", toolCalls: [] });
  });
});

describe("the local model (Ollama)", () => {
  function fakeOllama(chatAnswer: Record<string, unknown>) {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) return Response.json({ models: [{ name: "helper:latest" }] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(chatAnswer);
    }) as typeof fetch;
    return { fetcher, bodies };
  }

  it("is available only when the configured model is installed", async () => {
    const { fetcher } = fakeOllama({});
    expect(await new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "helper", fetch: fetcher }).available()).toBe(true);
    expect(await new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "missing", fetch: fetcher }).available()).toBe(false);
    expect(await new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "", fetch: fetcher }).available()).toBe(false);
    const down = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await new OllamaProvider({ baseUrl: "http://127.0.0.1:11434", model: "helper", fetch: down }).available()).toBe(false);
  });

  it("sends the conversation with tools and reads a tool request back", async () => {
    const { fetcher, bodies } = fakeOllama({ model: "helper", message: { content: "", tool_calls: [{ function: { name: "get_overview", arguments: {} } }] }, prompt_eval_count: 40, eval_count: 7 });
    const provider = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434/", model: "helper", fetch: fetcher });
    const response = await provider.chat({ system: "You are HELIOS.", messages: [{ role: "user", text: "What is due?" }], tools: toolSpecs() });

    expect(bodies[0]).toMatchObject({ model: "helper", stream: false, messages: [{ role: "system", content: "You are HELIOS." }, { role: "user", content: "What is due?" }] });
    expect((bodies[0]?.tools as { type: string }[])[0]?.type).toBe("function");
    expect(response).toMatchObject({ stop: "tool_use", toolCalls: [{ name: "get_overview", input: {} }], usage: { inputTokens: 40, outputTokens: 7 } });
    expect(response.toolCalls[0]?.id).toMatch(/^ollama-/);
  });
});
