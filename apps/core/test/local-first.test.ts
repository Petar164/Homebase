import { readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { CoreEvent } from "@homebase/shared";
import { describe, expect, it } from "vitest";
import { type ClaudeClient, ClaudeProvider } from "../src/ai/claude.ts";
import { Helios } from "../src/ai/helios.ts";
import { chooseProvider, claudeRequestIn, namesClaudeInACommand } from "../src/ai/policy.ts";
import { type ChatRequest, type ChatResponse, type ModelProvider, ProviderError, type ProviderRole, SENSITIVITY } from "../src/ai/types.ts";
import { saveConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { buildServer } from "../src/http/server.ts";
import { type Instance, openInstance } from "../src/instance.ts";
import { dataPaths } from "../src/paths.ts";
import { setOwnerPassword } from "../src/security/owner.ts";
import { silentLogger } from "../src/util.ts";
import type { Opener } from "../src/web/http.ts";
import { WebAccess } from "../src/web/service.ts";
import { taskTitles, tempDir, track } from "./helpers.ts";

// HELIOS is local first. The model on this machine answers. Claude answers
// one message, and only a message in which the owner asked for it: in so
// many words, or with the screen's "Ask Claude". Switching cloud models on
// makes that possible. It never makes HELIOS choose Claude by itself.
//
// Nothing here reaches Anthropic: the models are scripted, and no test
// needs a key.

const KEY = "test-placeholder";
const PASSWORD = "test-only password 1234";
const HOST = "localhost:7117";
const call = (name: string, input: unknown, id = "c1") => ({ id, name, input });

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
const localModel = (script: (Partial<ChatResponse> | Error)[] = []) => new ScriptedProvider("local", "local", script);
const claudeModel = (script: (Partial<ChatResponse> | Error)[] = []) => new ScriptedProvider("cloud", "cloud", script, "strong");

/**
 * A search service played by this file, set so that every web request
 * waits for the owner's yes. Nothing reaches the internet, and the one
 * result it finds is invented.
 */
function playedWeb(instance: Instance) {
  Object.assign(instance.config.web, { enabled: true, confirmEvery: true });
  const searches: string[] = [];
  const fetcher = (async (address: string | URL | Request) => {
    searches.push(new URL(String(address)).searchParams.get("q") ?? "");
    return Response.json({ type: "search", web: { results: [{ title: "Small models get faster", url: "https://news.example.org/small-models", description: "A report on how small models improved this month." }] } });
  }) as typeof fetch;
  const opener: Opener = async () => ({ status: 404, headers: {}, body: Readable.from([]) });
  return { searches, web: new WebAccess({ settings: () => instance.config.web, env: { BRAVE_SEARCH_API_KEY: KEY }, fetch: fetcher, opener }) };
}

/** `cloud: true` stands for an owner who has switched cloud models on. `web: true` adds the played search service. */
async function setup(providers: ModelProvider[], options: { cloud?: boolean; web?: boolean } = {}): Promise<{ instance: Instance; helios: Helios; events: CoreEvent[]; searches: string[] }> {
  const instance = track(await openInstance({ dataDir: tempDir() }));
  if (options.cloud) instance.config.ai.cloud.allowed = true;
  const bus = new EventBus();
  const events: CoreEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const played = options.web ? playedWeb(instance) : null;
  return { instance, helios: new Helios({ instance, providers, bus, log: silentLogger, ...(played ? { web: played.web } : {}) }), events, searches: played?.searches ?? [] };
}

/** The core behind its login, as the screen reaches it. */
async function loggedIn(instance: Instance, providers: ModelProvider[]) {
  await setOwnerPassword(instance.db, "owner", PASSWORD);
  const { app } = await buildServer({ instance, log: silentLogger, providers });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { host: HOST, origin: `http://${HOST}` }, payload: { username: "owner", password: PASSWORD } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  const send = (method: "GET" | "PUT" | "POST", url: string, body?: object) => app.inject({ method, url, headers: { host: HOST, origin: `http://${HOST}`, cookie }, ...(body ? { payload: body } : {}) });
  return { app, send };
}

const sent = (instance: Instance) => (instance.db.prepare("SELECT outcome FROM egress_log ORDER BY at, rowid").all() as { outcome: string }[]).map((row) => row.outcome);
const lines = (turn: { messages: { role: string; text: string }[] }) => turn.messages.map((message) => [message.role, message.text]);
const OFF = "Claude is switched off on this machine, so it was not asked. You can turn cloud models on from the main screen.";
const NOT_CLAUDE = "The answer below is from the model on this machine, not from Claude.";
const NOT_TAKEN = 'I did not take that as a request for Claude, so the answer below is from this machine. To ask Claude, begin your message with "Ask Claude".';
const MOVED_ON = "This belongs to an earlier question that asked for Claude. You have said something else since, so Claude is not asked again, and the answer below is not from Claude.";

describe("Claude answers only when the owner asks for it", () => {
  it("keeps an ordinary question on this machine, with cloud models off and with them on", async () => {
    const local = localModel([{ text: "from this machine" }, { text: "again from this machine" }]);
    const claude = claudeModel([{ text: "must not be asked" }]);
    const { instance, helios } = await setup([local, claude]);

    const off = await helios.handleMessage("What is due this week?");
    expect(lines(off)).toEqual([["user", "What is due this week?"], ["assistant", "from this machine"]]);
    expect(off.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });

    // Switched on, with a model that is ready: still nobody asked for Claude.
    instance.config.ai.cloud.allowed = true;
    const on = await helios.handleMessage("What is due this week?", { conversationId: off.conversationId });
    expect(lines(on)).toEqual([["user", "What is due this week?"], ["assistant", "again from this machine"]]);
    expect(on.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    expect(claude.requests).toHaveLength(0);
    expect(sent(instance)).toEqual([]);
  });

  it("keeps a difficult or a long question on this machine too", async () => {
    const hard = [
      "Compare the two suppliers, analyse the trade-offs in depth and write a strategy for the next year, step by step.",
      // The words that used to select the cloud model in earlier versions.
      "Think hard about this, use the strongest model you have and give me a deep analysis: which plan is better?",
      "I am not sure you can handle this one. It is very difficult and I need the best possible answer.",
      `${"This is a long question about how my week is planned. ".repeat(60)}What should I do first?`,
    ];
    expect(hard[3]?.length).toBeGreaterThan(3000);
    const local = localModel(hard.map((_, index) => ({ text: `local answer ${index + 1}` })));
    const claude = claudeModel([{ text: "must not be asked" }]);
    const { instance, helios } = await setup([local, claude], { cloud: true });

    for (const [index, question] of hard.entries()) {
      const turn = await helios.handleMessage(question);
      expect(turn.messages.at(-1), question.slice(0, 40)).toMatchObject({ text: `local answer ${index + 1}`, model: "local-model", route: "an ordinary request" });
      expect(turn.messages[0]?.askedClaude).toBeUndefined();
    }
    expect(claude.requests).toHaveLength(0);
    expect(sent(instance)).toEqual([]);
  });

  it("sends a message to Claude when it asks for Claude, in words or with the screen's Ask Claude", async () => {
    const local = localModel([{ text: "must not be asked" }]);
    const claude = claudeModel([{ text: "Claude's view." }, { text: "Claude again." }]);
    const { instance, helios, events } = await setup([local, claude], { cloud: true });

    const words = await helios.handleMessage("Ask Claude to analyze this.");
    expect(words.messages[0]).toMatchObject({ role: "user", askedClaude: true });
    expect(words.messages.at(-1)).toMatchObject({ text: "Claude's view.", model: "cloud-model", route: "you asked for Claude" });

    const button = await helios.handleMessage("What should I do first?", { conversationId: words.conversationId, claude: true });
    expect(button.messages[0]).toMatchObject({ role: "user", askedClaude: true });
    expect(button.messages.at(-1)).toMatchObject({ text: "Claude again.", model: "cloud-model", route: "you asked for Claude" });
    expect(local.requests).toHaveLength(0);

    // Each request is written down: who asked, how, and on which channel. And each call is in the record of what left the machine.
    const asked = instance.db.prepare("SELECT actor, target, detail FROM audit_log WHERE action = 'cloud.requested' ORDER BY seq").all();
    expect(asked).toEqual([
      { actor: "owner", target: words.conversationId, detail: JSON.stringify({ how: "ask", channel: "text" }) },
      { actor: "owner", target: words.conversationId, detail: JSON.stringify({ how: "screen", channel: "text" }) },
    ]);
    expect(sent(instance)).toEqual(["sent", "sent"]);
    // The screen is told while Claude is at work, by name, and when it has finished.
    expect(events.filter((event) => event.type === "answering")).toEqual([
      { type: "answering", conversationId: words.conversationId, model: "cloud-model", cloud: true },
      { type: "answering", conversationId: words.conversationId, model: null, cloud: false },
      { type: "answering", conversationId: words.conversationId, model: "cloud-model", cloud: true },
      { type: "answering", conversationId: words.conversationId, model: null, cloud: false },
    ]);
  });

  it("sends nothing when Claude is asked for while cloud models are off, says so first, and leaves the switch alone", async () => {
    const local = localModel([{ text: "from this machine" }]);
    const claude = claudeModel([{ text: "must not be asked" }]);
    const { instance, helios, events } = await setup([local, claude]);

    const turn = await helios.handleMessage("Use Claude for this question: what is due?", { channel: "voice" });
    expect(lines(turn)).toEqual([
      ["user", "Use Claude for this question: what is due?"],
      ["system", `${OFF} The answer below is from the model on this machine.`],
      ["assistant", "from this machine"],
    ]);
    expect(turn.messages.at(-1)).toMatchObject({ model: "local-model", route: "you asked for Claude, but cloud models are switched off" });
    expect(claude.requests).toHaveLength(0);
    expect(sent(instance)).toEqual([]);
    // Asking for Claude does not turn anything on.
    expect(instance.config.ai.cloud.allowed).toBe(false);
    // The remark is handed to the voice before the answer it is about, so it is heard first.
    const heardInOrder = events.filter((event) => event.type === "notice" || (event.type === "message" && event.message.role === "assistant")).map((event) => event.type);
    expect(heardInOrder).toEqual(["notice", "message"]);
    expect(events.find((event) => event.type === "notice")).toMatchObject({ text: `${OFF} The answer below is from the model on this machine.` });
  });

  it("does not take a mention of Claude for a request", async () => {
    const mentions = ["What do you think about Claude compared with other models?", "I read that Claude was updated yesterday.", "Don't use Claude for this, just tell me what is due."];
    const local = localModel(mentions.map(() => ({ text: "from this machine" })));
    const claude = claudeModel([{ text: "must not be asked" }]);
    const { helios } = await setup([local, claude], { cloud: true });
    for (const mention of mentions) {
      const turn = await helios.handleMessage(mention);
      expect(turn.messages[0]?.askedClaude, mention).toBeUndefined();
      expect(turn.messages.at(-1), mention).toMatchObject({ model: "local-model", route: "an ordinary request" });
    }
    expect(claude.requests).toHaveLength(0);
  });

  it("says so, before the answer, when a message holds words like 'ask Claude' without beginning with them", async () => {
    const claude = claudeModel([{ text: "must not be asked" }]);
    const local = localModel([{ text: "Drop the newsletter." }, { text: "Understood." }, { text: "A model made by Anthropic." }]);
    const { instance, helios, events } = await setup([local, claude], { cloud: true });

    // The request does not come first, so it is not one. The owner is told that, and how to ask, before the answer.
    const late = await helios.handleMessage("What should I drop this week? Ask Claude.");
    expect(lines(late)).toEqual([
      ["user", "What should I drop this week? Ask Claude."],
      ["system", NOT_TAKEN],
      ["assistant", "Drop the newsletter."],
    ]);
    expect(late.messages[0]?.askedClaude).toBeUndefined();
    expect(late.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    // Handed to the voice before the answer, so it is heard first.
    const heardInOrder = events.filter((event) => event.type === "notice" || (event.type === "message" && event.message.role === "assistant")).map((event) => event.type);
    expect(heardInOrder).toEqual(["notice", "message"]);
    expect(events.find((event) => event.type === "notice")).toMatchObject({ text: NOT_TAKEN });

    // A refusal that pauses before the words is not turned into its opposite, and HELIOS says how it took it.
    const refusal = await helios.handleMessage("Don't, under any circumstances, ask Claude about this.", { conversationId: late.conversationId });
    expect(lines(refusal)).toEqual([
      ["user", "Don't, under any circumstances, ask Claude about this."],
      ["system", NOT_TAKEN],
      ["assistant", "Understood."],
    ]);

    // A plain mention holds no command, and gets no remark.
    const mention = await helios.handleMessage("What is Claude?", { conversationId: late.conversationId });
    expect(lines(mention)).toEqual([
      ["user", "What is Claude?"],
      ["assistant", "A model made by Anthropic."],
    ]);

    expect(claude.requests).toHaveLength(0);
    expect(sent(instance)).toEqual([]);
    expect(instance.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'cloud.requested'").get()).toEqual({ n: 0 });
  });

  it("still asks before sensitive records go to Claude", async () => {
    const claude = claudeModel([{ toolCalls: [call("get_money_summary", { month: "2026-11" })] }, { text: "must not be reached without a yes" }]);
    const { instance, helios } = await setup([localModel(), claude], { cloud: true });

    const turn = await helios.handleMessage("Ask Claude how the shop did this month.");
    // One call went out, before anything sensitive was in the conversation. Then the money figures came in, and the turn stopped to ask.
    expect(claude.requests).toHaveLength(1);
    expect(turn.approvals).toHaveLength(1);
    expect(turn.approvals[0]).toMatchObject({ kind: "cloud_egress", status: "pending" });
    expect(sent(instance)).toEqual(["sent", "held_for_approval"]);

    // A no means nothing more is sent, and the owner is told how to get an answer on this machine.
    await helios.decide(turn.approvals[0]?.id as string, "deny", null);
    expect(claude.requests).toHaveLength(1);
    expect(sent(instance)).toEqual(["sent", "held_for_approval"]);
    expect(helios.messages(turn.conversationId).at(-1)).toMatchObject({ role: "system", text: "Not sent: nothing more went to Claude. Ask again without asking for Claude, and the model on this machine answers." });
  });

  it("makes no call when the month's budget is used up", async () => {
    const local = localModel([{ text: "from this machine" }]);
    const claude = claudeModel([{ text: "must not be asked" }]);
    const { instance, helios } = await setup([local, claude], { cloud: true });
    instance.config.ai.cloud.budget.capEur = 0;

    const turn = await helios.handleMessage("Ask Claude about this plan.");
    expect(lines(turn)).toEqual([
      ["user", "Ask Claude about this plan."],
      ["system", "This month's cloud budget is used up, so Claude was not asked. The answer below is from the model on this machine."],
      ["assistant", "from this machine"],
    ]);
    expect(turn.messages.at(-1)).toMatchObject({ model: "local-model", route: "you asked for Claude, but this month's cloud budget is used up" });
    expect(claude.requests).toHaveLength(0);
    expect(sent(instance)).toEqual([]);
  });

  it("lets the local model answer under its own name when Claude fails, and says so before the answer", async () => {
    const local = localModel([{ text: "from this machine" }]);
    const claude = claudeModel([new ProviderError("auth", "Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in the .env file.")]);
    const { helios, events } = await setup([local, claude], { cloud: true });

    const turn = await helios.handleMessage("Ask Claude about this plan.");
    expect(lines(turn)).toEqual([
      ["user", "Ask Claude about this plan."],
      ["system", "cloud-model could not answer. Anthropic did not accept the API key. Check ANTHROPIC_API_KEY in the .env file."],
      ["system", NOT_CLAUDE],
      ["assistant", "from this machine"],
    ]);
    // The answer is marked with the model that wrote it. It is never shown as Claude's.
    expect(turn.messages.at(-1)).toMatchObject({ model: "local-model", route: "you asked for Claude, but it could not answer" });
    // Both remarks are handed to the voice before the answer.
    const heardInOrder = events.filter((event) => event.type === "notice" || (event.type === "message" && event.message.role === "assistant")).map((event) => event.type);
    expect(heardInOrder).toEqual(["notice", "notice", "message"]);
  });

  it("treats the next message as an ordinary one again", async () => {
    const local = localModel([{ text: "local one" }, { text: "local two" }]);
    const claude = claudeModel([{ text: "Claude's view." }]);
    const { helios } = await setup([local, claude], { cloud: true });

    const first = await helios.handleMessage("Ask Claude about this plan.");
    expect(first.messages.at(-1)).toMatchObject({ model: "cloud-model" });
    // What follows continues the same conversation, and does not inherit the request.
    const next = await helios.handleMessage("And what about tomorrow?", { conversationId: first.conversationId });
    const third = await helios.handleMessage("Yes, go on with that.", { conversationId: first.conversationId });
    for (const turn of [next, third]) {
      expect(turn.messages[0]?.askedClaude).toBeUndefined();
      expect(turn.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    }
    expect(claude.requests).toHaveLength(1);
    // The local model carries on with the conversation as it stands, Claude's answer included.
    expect(JSON.stringify(local.requests[0]?.messages)).toContain("Claude's view.");
  });

  it("cannot be set back to choosing by itself: not by an older settings file, not by an older screen", async () => {
    // Settings that used to send questions to the cloud by themselves.
    const dataDir = tempDir();
    writeFileSync(dataPaths(dataDir).configFile, JSON.stringify({ ai: { prefer: "cloud", routing: { complexChars: 50 }, cloud: { allowed: true, enabled: true } } }));
    const instance = track(await openInstance({ dataDir }));
    expect(instance.config.ai).not.toHaveProperty("prefer");
    expect(instance.config.ai).not.toHaveProperty("routing");
    expect(instance.config.ai.cloud.allowed).toBe(true); // the owner's switch itself is kept: Claude may be asked for

    const local = localModel([{ text: "local one" }, { text: "local two" }]);
    const claude = claudeModel([{ text: "must not be asked" }]);
    const light = new ScriptedProvider("light", "cloud", [{ text: "must not be asked" }], "light");
    const { app, send } = await loggedIn(instance, [local, claude, light]);
    try {
      const long = await send("POST", "/api/helios/message", { text: "Compare the two suppliers and analyse the trade-offs in depth, step by step, for the whole of next year." });
      expect(long.json<{ messages: { model: string | null }[] }>().messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
      // An older screen sent this along with "think hard". It is dropped.
      const older = await send("POST", "/api/helios/message", { text: "Which plan is better?", reasoning: "strong" });
      expect(older.statusCode).toBe(200);
      expect(older.json<{ messages: { model: string | null }[] }>().messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
      // Only a plain yes counts as the screen's Ask Claude.
      expect((await send("POST", "/api/helios/message", { text: "Which plan is better?", claude: "yes" })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
    expect(claude.requests).toHaveLength(0);
    expect(light.requests).toHaveLength(0);

    // The next time the settings are saved, the old entries are gone from the file.
    saveConfig(instance.paths, instance.config);
    const saved = JSON.parse(readFileSync(instance.paths.configFile, "utf8")) as { ai: Record<string, unknown> };
    expect(saved.ai).not.toHaveProperty("prefer");
    expect(saved.ai).not.toHaveProperty("routing");
  });

  it("makes a later change wait for the owner after a model failed", async () => {
    // Claude fails before anything was done. The local model takes over and asks for a change.
    const claude = claudeModel([new ProviderError("network", "Anthropic could not be reached. Check the internet connection.")]);
    const local = localModel([{ toolCalls: [call("add_task", { title: "Written after a failure", area: "inbox" })] }, { text: "I have asked you to confirm." }]);
    const { instance, helios } = await setup([local, claude], { cloud: true });
    instance.config.ai.autoApproveTier1 = true; // small changes run without asking, as long as nothing went wrong

    const turn = await helios.handleMessage("Ask Claude to add that task.");
    expect(taskTitles(instance)).toEqual([]);
    expect(turn.approvals).toHaveLength(1);
    expect(turn.approvals[0]).toMatchObject({ kind: "tool", tier: 1, status: "pending" });
  });

  it("does not let an approval be used twice, or a repeated request ride on it", async () => {
    const task = { title: "Call the bank", area: "inbox" };
    const local = localModel([
      { toolCalls: [call("add_task", task, "a1")] },
      { text: "Waiting for your yes." },
      // Later the model asks for exactly the same thing again.
      { toolCalls: [call("add_task", task, "a2")] },
      { text: "Waiting for your yes again." },
    ]);
    const { instance, helios } = await setup([local]);

    const first = await helios.handleMessage("Add a task to call the bank.");
    const yes = first.approvals[0]?.id as string;
    await helios.decide(yes, "approve", null);
    expect(taskTitles(instance)).toEqual(["Call the bank"]);

    // The repeated request does not run on the yes that was given before. It gets a card of its own.
    const second = await helios.handleMessage("Add it once more.", { conversationId: first.conversationId });
    expect(second.approvals).toHaveLength(1);
    expect(second.approvals[0]?.id).not.toBe(yes);
    expect(second.approvals[0]).toMatchObject({ status: "pending" });
    expect(taskTitles(instance)).toEqual(["Call the bank"]);
    // The first yes cannot be given again, and a no runs nothing.
    await expect(helios.decide(yes, "approve", null)).rejects.toMatchObject({ status: 409 });
    await helios.decide(second.approvals[0]?.id as string, "deny", null);
    expect(taskTitles(instance)).toEqual(["Call the bank"]);
    expect(instance.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.run'").get()).toEqual({ n: 1 });
  });

  it("makes no request when its status is looked at", async () => {
    // Making a client is the first step towards any request. Looking must never get that far.
    let made = 0;
    const claude = new ClaudeProvider({
      role: "strong",
      model: "claude-sonnet-5-5",
      env: { ANTHROPIC_API_KEY: KEY },
      createClient: () => {
        made++;
        return {} as ClaudeClient;
      },
    });
    const instance = track(await openInstance({ dataDir: tempDir() }));
    instance.config.ai.cloud.allowed = true;
    const { app, send } = await loggedIn(instance, [localModel(), claude]);
    try {
      for (let index = 0; index < 3; index++) {
        const status = (await send("GET", "/api/helios/status")).json<{ cloud: { enabled: boolean; ready: boolean; service: string } }>();
        expect(status.cloud).toMatchObject({ enabled: true, ready: true, service: "Anthropic" });
      }
      expect((await send("PUT", "/api/ai/cloud", { enabled: false })).json()).toMatchObject({ enabled: false, ready: false });
    } finally {
      await app.close();
    }
    expect(claude.describe()).toEqual({ service: "Anthropic", problem: null });
    expect(await claude.available()).toBe(true);
    expect(made).toBe(0);
    expect(sent(instance)).toEqual([]);
  });
});

describe("where one question ends and the next begins", () => {
  it("closes a card about an earlier question when the next message comes", async () => {
    const claude = claudeModel([{ toolCalls: [call("get_money_summary", { month: "2026-11" })] }, { text: "must not be reached" }]);
    const local = localModel([{ text: "from this machine" }]);
    const { instance, helios, events } = await setup([local, claude], { cloud: true });

    const held = await helios.handleMessage("Ask Claude how the shop did this month.");
    const card = held.approvals[0]?.id as string;
    expect(helios.pendingApprovals().map((approval) => approval.id)).toEqual([card]);

    // The owner moves on with an ordinary question. The card belonged to the question before it.
    const next = await helios.handleMessage("What is due tomorrow?", { conversationId: held.conversationId });
    expect(next.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    expect(helios.pendingApprovals()).toEqual([]);
    expect(instance.db.prepare("SELECT status FROM approvals WHERE id = ?").get(card)).toEqual({ status: "expired" });
    expect(events.some((event) => event.type === "approval" && event.approval.id === card && event.approval.status === "expired")).toBe(true);

    // A yes that comes too late does not send the newer conversation to Claude.
    await expect(helios.decide(card, "approve", null)).rejects.toMatchObject({ status: 409 });
    expect(claude.requests).toHaveLength(1);
  });

  it("does not send a newer conversation on a yes that comes too late, also when the card was left open", async () => {
    const claude = claudeModel([{ toolCalls: [call("get_money_summary", { month: "2026-11" })] }, { text: "must not be reached" }]);
    const { instance, helios } = await setup([localModel(), claude], { cloud: true });
    const held = await helios.handleMessage("Ask Claude how the shop did this month.");
    const card = held.approvals[0]?.id as string;
    // A newer message of the owner's that reached the transcript some other way, so that nothing closed the card.
    instance.db
      .prepare("INSERT INTO messages (id, conversation_id, seq, role, text, sensitivity, created_at) SELECT 'late-message', ?, MAX(seq) + 1, 'user', 'What is due tomorrow?', 'private', ? FROM messages WHERE conversation_id = ?")
      .run(held.conversationId, new Date().toISOString(), held.conversationId);
    expect(helios.pendingApprovals().map((approval) => approval.id)).toEqual([card]);

    // The yes is checked against the question the card was about. That question is over.
    await expect(helios.decide(card, "approve", null)).rejects.toMatchObject({ status: 409 });
    expect(claude.requests).toHaveLength(1);
    expect(instance.db.prepare("SELECT status FROM approvals WHERE id = ?").get(card)).toEqual({ status: "expired" });
  });

  it("refuses a second message while Claude is answering, and does not let it ride along", async () => {
    let release: (() => void) | undefined;
    const slow: ModelProvider = {
      id: "cloud",
      role: "strong",
      location: "cloud",
      model: "cloud-model",
      available: async () => true,
      chat: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { text: "Claude's view.", toolCalls: [], stop: "end", usage: { inputTokens: 10, outputTokens: 5 }, model: "cloud-model" };
      },
    };
    const local = localModel([{ text: "from this machine" }]);
    const { instance, helios } = await setup([local, slow], { cloud: true });

    const first = helios.handleMessage("Ask Claude about this plan.");
    for (let tries = 0; tries < 200 && !release; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(helios.handleMessage("What is due?")).rejects.toMatchObject({ status: 409 });
    release?.();

    const done = await first;
    expect(done.messages.at(-1)).toMatchObject({ text: "Claude's view.", model: "cloud-model" });
    // The message that was turned away left nothing behind, and the one after the answer is an ordinary one.
    const after = await helios.handleMessage("What is due?", { conversationId: done.conversationId });
    expect(after.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    expect(instance.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user'").get()).toEqual({ n: 2 });
    expect(local.requests).toHaveLength(1);
  });

  it("lets a turn that was held go on with Claude after the owner's yes, and no further", async () => {
    const claude = claudeModel([{ toolCalls: [call("get_money_summary", { month: "2026-11" })] }, { text: "You made one sale." }]);
    const local = localModel([{ text: "from this machine" }]);
    const { helios } = await setup([local, claude], { cloud: true });

    // Asked for with the screen's button: nothing in the words says "Claude".
    const held = await helios.handleMessage("How did the shop do this month?", { claude: true });
    const { turn } = await helios.decide(held.approvals[0]?.id as string, "approve", null);
    // The same question goes on, with the model it asked for: that is read from the owner's message, not from the card.
    expect(turn?.messages.at(-1)).toMatchObject({ text: "You made one sale.", model: "cloud-model", route: "you asked for Claude" });

    const next = await helios.handleMessage("Thanks. What is due?", { conversationId: held.conversationId });
    expect(next.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    expect(claude.requests).toHaveLength(2);
  });

  it("lets a web search that Claude asked for go on with Claude after the owner's yes, as long as nothing else was said", async () => {
    const claude = claudeModel([{ toolCalls: [call("search_web", { query: "local AI models" })] }, { text: "I am waiting for your yes to search the web." }, { text: "Small models got faster this month [1]." }]);
    const { helios, searches } = await setup([localModel(), claude], { cloud: true, web: true });

    const held = await helios.handleMessage("Ask Claude to find news about local AI models.");
    expect(held.approvals[0]).toMatchObject({ kind: "tool", status: "pending" });
    expect(searches).toEqual([]);

    // The yes is for the search. The question is still the one that asked for Claude, so Claude reads what came back.
    const { turn } = await helios.decide(held.approvals[0]?.id as string, "approve", null);
    expect(searches).toEqual(["local AI models"]);
    expect(turn?.messages.at(-1)).toMatchObject({ text: "Small models got faster this month [1].", model: "cloud-model", route: "you asked for Claude" });
    expect(claude.requests).toHaveLength(3);
  });

  it("does not bring Claude into an ordinary question whose card is answered after a later message asked for Claude", async () => {
    const local = localModel([{ toolCalls: [call("search_web", { query: "local AI models" })] }, { text: "I am waiting for your yes to search the web." }, { text: "Small models got faster this month [1]." }]);
    const claude = claudeModel([{ text: "Claude's view." }, { text: "must not be reached" }]);
    const { helios, searches } = await setup([local, claude], { cloud: true, web: true });

    // An ordinary question. Its web search waits for a yes.
    const first = await helios.handleMessage("Search the web for news about local AI models.");
    const card = first.approvals[0]?.id as string;
    expect(first.approvals[0]).toMatchObject({ kind: "tool", status: "pending" });

    // Before answering the card, the owner asks Claude something. That one message goes to Claude.
    const second = await helios.handleMessage("Ask Claude whether small models are good enough for this.", { conversationId: first.conversationId });
    expect(second.messages.at(-1)).toMatchObject({ text: "Claude's view.", model: "cloud-model", route: "you asked for Claude" });
    expect(claude.requests).toHaveLength(1);

    // Now the yes for the search. What it brings back belongs to the ordinary question, and is read on this machine.
    const { turn } = await helios.decide(card, "approve", null);
    expect(searches).toEqual(["local AI models"]);
    expect(turn?.messages.at(-1)).toMatchObject({ text: "Small models got faster this month [1].", model: "local-model", route: "an ordinary request" });
    expect(turn?.messages.map((message) => message.text)).not.toContain(MOVED_ON);
    expect(claude.requests).toHaveLength(1);
  });

  it("does not go back to Claude for a question the owner has moved on from, and says so before the answer", async () => {
    const claude = claudeModel([{ toolCalls: [call("search_web", { query: "local AI models" })] }, { text: "I am waiting for your yes to search the web." }, { text: "must not be reached" }]);
    const local = localModel([{ text: "Two tasks are due." }, { text: "Small models got faster this month [1]." }]);
    const { helios, searches, events } = await setup([local, claude], { cloud: true, web: true });

    // Claude is asked, and wants to search the web. The search waits for a yes.
    const first = await helios.handleMessage("Ask Claude to find news about local AI models.");
    const card = first.approvals[0]?.id as string;
    expect(claude.requests).toHaveLength(2);

    // The owner moves on with an ordinary question.
    const next = await helios.handleMessage("What is due tomorrow?", { conversationId: first.conversationId });
    expect(next.messages.at(-1)).toMatchObject({ text: "Two tasks are due.", model: "local-model" });

    // The yes comes afterwards. The search runs, as approved. Claude is not asked again: that question is over.
    const { turn } = await helios.decide(card, "approve", null);
    expect(searches).toEqual(["local AI models"]);
    expect(claude.requests).toHaveLength(2);
    expect(lines(turn as { messages: { role: string; text: string }[] })).toEqual([
      ["system", 'Done: Search the web for "local AI models".'],
      ["system", MOVED_ON],
      ["assistant", "Small models got faster this month [1]."],
    ]);
    expect(turn?.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    // The remark is also handed to the voice, so that it is said before the answer.
    expect(events.filter((event) => event.type === "notice").map((event) => (event.type === "notice" ? event.text : ""))).toContain(MOVED_ON);
  });

  it("reads what a card of an earlier version brings back on this machine, because that card does not say which question it was for", async () => {
    const claude = claudeModel([{ toolCalls: [call("search_web", { query: "local AI models" })] }, { text: "I am waiting for your yes to search the web." }, { text: "must not be reached" }]);
    const local = localModel([{ text: "Small models got faster this month [1]." }]);
    const { instance, helios, searches } = await setup([local, claude], { cloud: true, web: true });

    const held = await helios.handleMessage("Ask Claude to find news about local AI models.");
    const card = held.approvals[0]?.id as string;
    // The card as an earlier version wrote it: without the place of the question it belongs to.
    const stored = instance.db.prepare("SELECT action FROM approvals WHERE id = ?").get(card) as { action: string };
    const { turnSeq, ...older } = JSON.parse(stored.action) as { turnSeq: number };
    expect(turnSeq).toBeGreaterThan(0);
    instance.db.prepare("UPDATE approvals SET action = ? WHERE id = ?").run(JSON.stringify(older), card);

    const { turn } = await helios.decide(card, "approve", null);
    expect(searches).toEqual(["local AI models"]);
    expect(turn?.messages.at(-1)).toMatchObject({ text: "Small models got faster this month [1].", model: "local-model" });
    expect(claude.requests).toHaveLength(2);
  });
});

describe("the words that ask for Claude", () => {
  it("are a fixed list of commands that name Claude, at the beginning of a message", () => {
    const requests: [said: string, form: string][] = [
      ["Ask Claude to analyze this.", "ask"],
      ["Use Claude for this question.", "use"],
      ["ask claude", "ask"],
      ["Please ask Claude about the plan.", "ask"],
      ["Can you ask Claude?", "ask"],
      ["Ok, can you ask Claude?", "ask"],
      ["Could you ask Claude to check my week?", "ask"],
      ["Can we ask Claude about this?", "ask"],
      ["I want you to ask Claude about this.", "ask"],
      ["I'd like to ask Claude about this.", "ask"],
      ["I’d like to ask Claude about this.", "ask"],
      ["Let's ask Claude.", "ask"],
      ["No, ask Claude instead.", "ask"],
      ["Ask Claude what is due?", "ask"],
      ["Ask Claude's opinion on this.", "ask"],
      ["Try Claude.", "use"],
      ["Use Claude, not the local model.", "use"],
      ["Let Claude answer this one.", "let"],
      ["Have Claude look at this.", "let"],
      ["Get Claude to check the numbers.", "get"],
      ["Send this to Claude.", "send"],
      ["Run it by Claude.", "send"],
      ["Switch to Claude for this.", "switch"],
      ["Check this with Claude.", "with"],
      ["Compare the two plans using Claude.", "using"],
      ["I want Claude for this one.", "want"],
      // The question may follow the command, in the same sentence or after it.
      ["Ask Claude: what is the best plan here?", "ask"],
      ["Use Claude for this question: how should I rearrange the shop?", "use"],
      ["Ask Claude to summarize this. Hi team, the meeting moved to Friday.", "ask"],
      // A greeting before it is passed over.
      ["Helios. Ask Claude to analyze this.", "ask"],
      ["Helios? Ask Claude what is due.", "ask"],
      ["Hey Helios, ask Claude what I should drop.", "ask"],
      ["Thanks. Now ask Claude to check it.", "ask"],
    ];
    for (const [said, form] of requests) expect(claudeRequestIn(said), said).toBe(form);
    // Every one of them holds a command that names Claude.
    for (const [said] of requests) expect(namesClaudeInACommand(said), said).toBe(true);
  });

  it("do not include mentions, questions, refusals, other products or the phrases of earlier versions", () => {
    const notRequests = [
      "What is due this week?",
      "Claude",
      "What is Claude?",
      "What do you think about Claude compared with other models?",
      "I read about Claude yesterday.",
      "I asked Claude yesterday and it said no.",
      "He said to ask Claude.",
      '"Ask Claude to do it" is what she wrote.',
      "My chat with Claude went badly.",
      "The report was written using Claude.",
      "Tell me about asking Claude.",
      // Wondering whether to is not telling HELIOS to.
      "Should I ask Claude?",
      "Can I ask Claude about this?",
      "Do I need to ask Claude for that?",
      "If I ask Claude, what does it cost?",
      "Why did you use Claude for that?",
      "We should ask Claude.",
      "You should ask Claude.",
      "Maybe ask Claude later.",
      "Will we ask Claude tomorrow?",
      "Ask Claude?",
      "Use Claude?",
      // Saying not to.
      "Don't ask Claude.",
      "Please do not use Claude for this.",
      "Never use Claude.",
      "You should not use Claude.",
      "I do not want you to ask Claude.",
      "Do not ask Claude, ask the local model.",
      "Stop using Claude.",
      // Other things with the name in them.
      "Use Claude Code to fix the build.",
      "Use claude.ai for this.",
      "Use Claude's API key from the .env file.",
      "I need Claude's pricing page.",
      "Use Claude Shannon's formula for this.",
      "Use Claude Max instead of the API.",
      "Explain the difference with Claude.",
      "Tell me how people write essays using Claude.",
      "You can use Claude to summarize documents. Is that true?",
      // Not the name.
      "Ask cloud to analyze this.",
      "Use the cloud model for this.",
      "Use the stronger model.",
      "Think hard about this.",
      "Use Sonnet for this.",
      "Give me a deep analysis.",
      // Speaking to Claude is not asking HELIOS for it.
      "Claude, what do you think?",
    ];
    for (const said of notRequests) expect(claudeRequestIn(said), said).toBeNull();
  });

  it("read only the beginning of a message: nothing later in it can ask for Claude", () => {
    // Each of these holds a command that names Claude, somewhere after the beginning.
    const later = [
      // A refusal that pauses before the words.
      "Don't, under any circumstances, ask Claude.",
      "Don't go and ask Claude.",
      "Whatever you do, do not... ask Claude.",
      // Thinking aloud, and what somebody else said.
      "I could just, you know, ask Claude.",
      "He said, ask Claude.",
      "There are other ways to get a second opinion, e.g. ask Claude or a friend.",
      // Text that was pasted in, with the owner's own words around it or before it.
      "Summarize this email for me. Hi team, we have a new process. Ask Claude to draft the report first. Then send it to me. What does it want from me?",
      "Summarize this article: Models keep getting better. Try Claude today.",
      "Options: 1. Do it myself. 2. Ask Claude. 3. Wait. Which is best?",
      // A request that does not come first. It stays on this machine, and HELIOS says so (see the test of that remark).
      "What is the best plan here? Ask Claude.",
      "Look at my week and ask Claude what to drop.",
      "Don't use the local model, use Claude.",
      "This is hard, ask Claude.",
    ];
    for (const said of later) {
      expect(claudeRequestIn(said), said).toBeNull();
      expect(namesClaudeInACommand(said), said).toBe(true);
    }
    // A plain mention holds no such command, so nothing needs to be said about it.
    for (const said of ["What is Claude?", "I read about Claude yesterday.", "Claude, what do you think?", "Use Claude Code to fix the build.", "Put this in the cloud.", "What is due this week?"]) {
      expect(namesClaudeInACommand(said), said).toBe(false);
    }
  });

  it("read spoken words the same way, as a speech recogniser writes them", () => {
    // No capitals, little punctuation, the name spelled by ear.
    expect(claudeRequestIn("helios ask claude to analyze this")).toBe("ask");
    expect(claudeRequestIn("hey helios use claude for this question")).toBe("use");
    expect(claudeRequestIn("ok so ask claud what is due this week")).toBe("ask");
    expect(claudeRequestIn("then ask klaud what to drop")).toBe("ask");
    // The request has to come first. Said after the question, in one breath
    // or as a sentence of its own, it is not recognised, and the question
    // stays on this machine.
    expect(claudeRequestIn("what is due this week and then ask claude what to drop")).toBeNull();
    expect(claudeRequestIn("What is due this week? Then ask Claude what to drop.")).toBeNull();
    expect(claudeRequestIn("i've got a problem with the shop numbers, ask claude to analyze them")).toBeNull();
    // A mention in passing, and the ordinary word that sounds like the name.
    expect(claudeRequestIn("i was talking to claude yesterday what is due this week")).toBeNull();
    expect(claudeRequestIn("put this in the cloud")).toBeNull();
    expect(claudeRequestIn("ask the cloud to analyze this")).toBeNull();
    expect(claudeRequestIn("dont ask claude")).toBeNull();
  });
});

describe("no other way to a cloud model", () => {
  const provider = (id: string, role: ProviderRole, location: "local" | "cloud"): ModelProvider => ({
    id,
    role,
    location,
    model: `${id}-model`,
    available: async () => true,
    chat: async () => {
      throw new Error("the router never calls a model");
    },
  });
  const pool = [provider("standin", "standin", "local"), provider("local", "local", "local"), provider("claude-strong", "strong", "cloud"), provider("claude-light", "light", "cloud")];
  const subsets = Array.from({ length: 2 ** pool.length }, (_, mask) => pool.filter((_, index) => mask & (1 << index)));
  const excludes = [undefined, ...pool.map((entry) => new Set([entry.id]))];

  it("exists in the router: without a request, no combination of circumstances chooses one", async () => {
    let tried = 0;
    for (const providers of subsets) {
      for (const cloudEnabled of [true, false]) {
        for (const sensitivity of SENSITIVITY) {
          for (const egressApproved of [true, false]) {
            for (const capReached of [true, false]) {
              for (const exclude of excludes) {
                // Also with what earlier versions put into a request to mark it as a hard one.
                for (const task of [{ claudeRequested: false }, { claudeRequested: false, strongRequested: true, complex: true }]) {
                  const route = await chooseProvider({ providers, cloudEnabled, task, sensitivity, egressApproved, capReached, exclude });
                  tried++;
                  expect(route.kind, JSON.stringify({ cloudEnabled, sensitivity, capReached })).not.toBe("needs_approval");
                  if (route.kind === "use") expect(route.provider.location).toBe("local");
                }
              }
            }
          }
        }
      }
    }
    expect(tried).toBe(16 * 2 * 4 * 2 * 2 * 5 * 2);
    // And the door does open for a request, when every condition holds: the check above is not empty.
    expect(await chooseProvider({ providers: pool, cloudEnabled: true, task: { claudeRequested: true }, sensitivity: "private", egressApproved: false, capReached: false })).toMatchObject({ kind: "use", provider: { id: "claude-strong" } });
    // Only the model set up for it answers a request: never the light one in its place.
    expect(await chooseProvider({ providers: [pool[1] as ModelProvider, pool[3] as ModelProvider], cloudEnabled: true, task: { claudeRequested: true }, sensitivity: "private", egressApproved: false, capReached: false })).toMatchObject({
      kind: "use",
      provider: { id: "local" },
      instead: "Claude cannot be asked: no cloud model is part of this installation. The answer below is from the model on this machine.",
    });
  });

  it("exists for a message: whatever else is handed in with it", async () => {
    const local = localModel([{ text: "one" }, { text: "two" }, { text: "three" }]);
    const claude = claudeModel([{ text: "must not be asked" }]);
    const { helios } = await setup([local, claude], { cloud: true });
    const junk = [{ reasoning: "strong" }, { claude: false, strongRequested: true }, { claude: undefined, model: "claude-sonnet-5-5", prefer: "cloud" }];
    for (const options of junk) {
      const turn = await helios.handleMessage("Which plan is better?", options as never);
      expect(turn.messages.at(-1)).toMatchObject({ model: "local-model", route: "an ordinary request" });
    }
    expect(claude.requests).toHaveLength(0);
  });
});
