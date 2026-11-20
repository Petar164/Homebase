import { describe, expect, it } from "vitest";
import { Helios } from "../src/ai/helios.ts";
import { budgetStatus, chooseProvider, costMicros, estimateMicros, reserve, type RouteInput, settle, settleAbandoned, warningDue } from "../src/ai/policy.ts";
import { StandInProvider } from "../src/ai/standin.ts";
import { toolSpecs } from "../src/ai/tools.ts";
import type { ChatRequest, ChatResponse, ModelProvider, ProviderRole } from "../src/ai/types.ts";
import { defaultConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { type Instance, openInstance } from "../src/instance.ts";
import { verifyAuditLog } from "../src/security/audit.ts";
import { silentLogger } from "../src/util.ts";
import { insertTask, taskTitles, tempDir, track } from "./helpers.ts";

/** A model that answers exactly what the test scripted, and records what it was sent. */
class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly role: ProviderRole;
  readonly location: "local" | "cloud";
  readonly model: string;
  readonly requests: ChatRequest[] = [];
  private script: Partial<ChatResponse>[];
  isAvailable = true;
  /** When set, the next call fails with this error. */
  failWith: Error | null = null;

  constructor(id: string, location: "local" | "cloud", script: Partial<ChatResponse>[] = [], role?: ProviderRole) {
    this.id = id;
    this.role = role ?? (location === "local" ? "local" : "strong");
    this.location = location;
    this.model = `${id}-model`;
    this.script = script;
  }
  async available() {
    return this.isAvailable;
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.failWith) throw this.failWith;
    this.requests.push(structuredClone({ ...request, onText: undefined }));
    const next = this.script.shift() ?? { text: "ok" };
    return { text: "", toolCalls: [], stop: next.toolCalls?.length ? "tool_use" : "end", usage: { inputTokens: 1000, outputTokens: 500 }, model: this.model, ...next };
  }
}

const call = (name: string, input: unknown, id = "c1") => ({ id, name, input });

/** `cloud: true` stands for an owner who has switched cloud models on. They are off in a fresh installation. */
async function setup(providers: ModelProvider[] = [new StandInProvider()], options: { cloud?: boolean } = {}): Promise<{ instance: Instance; helios: Helios; events: string[] }> {
  const instance = track(await openInstance({ dataDir: tempDir() }));
  if (options.cloud) instance.config.ai.cloud.allowed = true;
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((event) => events.push(event.type === "state" ? `state:${event.state}` : event.type));
  return { instance, helios: new Helios({ instance, providers, bus, log: silentLogger }), events };
}

describe("a conversation", () => {
  it("answers from real records through a tool, and stores every step", async () => {
    const { instance, helios, events } = await setup();
    insertTask(instance, "t1", "Hand in the assignment");

    const turn = await helios.handleMessage("What is due this week?");
    expect(turn.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(turn.messages[1]?.text).toContain("Hand in the assignment");

    // The transcript holds the whole exchange, including the tool traffic the screen hides.
    const roles = (instance.db.prepare("SELECT role FROM messages ORDER BY seq").all() as { role: string }[]).map((row) => row.role);
    // (The first row is the hidden note that tells the model today's date.)
    expect(roles).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(events).toEqual(expect.arrayContaining(["state:thinking", "state:acting", "state:idle", "message"]));
    expect(helios.listConversations()[0]?.title).toBe("What is due this week?");
  });

  it("is still there after a restart", async () => {
    const dataDir = tempDir();
    const first = track(await openInstance({ dataDir }));
    const before = new Helios({ instance: first, providers: [new StandInProvider()], bus: new EventBus(), log: silentLogger });
    const { conversationId } = await before.handleMessage("What is due?");
    first.close();

    const second = track(await openInstance({ dataDir }));
    const after = new Helios({ instance: second, providers: [new StandInProvider()], bus: new EventBus(), log: silentLogger });
    expect(after.messages(conversationId).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("never rewrites a transcript", async () => {
    const { instance, helios } = await setup();
    await helios.handleMessage("What is due?");
    expect(() => instance.db.prepare("UPDATE messages SET text = 'changed'").run()).toThrow(/never rewritten/);
  });

  it("gives the model the earlier turns of the same conversation", async () => {
    const model = new ScriptedProvider("local", "local", [{ text: "First answer." }, { text: "Second answer." }]);
    const { helios } = await setup([model]);
    const { conversationId } = await helios.handleMessage("First question");
    await helios.handleMessage("Second question", { conversationId });
    expect(model.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(model.requests[1]?.system).toContain("HELIOS");
  });
});

describe("what a model may do", () => {
  it("is offered tools as JSON Schema it can read", () => {
    const add = toolSpecs().find((tool) => tool.name === "add_task");
    expect(add?.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["title", "area"]) });
  });

  it("gets an error, not a crash, for a tool that does not exist or bad input", async () => {
    const model = new ScriptedProvider("local", "local", [
      { toolCalls: [call("delete_everything", {}, "a"), call("complete_task", { id: "../../etc" }, "b")] },
      { text: "Understood." },
    ]);
    const { helios } = await setup([model]);
    await helios.handleMessage("Do something odd");
    const results = model.requests[1]?.messages.at(-1);
    expect(results).toMatchObject({ role: "tool", results: [{ isError: true }, { isError: true }] });
  });

  it("cannot change anything without the owner's yes", async () => {
    const { instance, helios } = await setup();
    const turn = await helios.handleMessage("Add a task to call the dentist");
    expect(taskTitles(instance)).toEqual([]); // asked for, not done
    expect(turn.approvals).toHaveLength(1);
    expect(turn.approvals[0]).toMatchObject({ kind: "tool", tier: 1, status: "pending" });
    expect(turn.messages.at(-1)?.text).toContain("Confirm");

    const { approval } = await helios.decide(turn.approvals[0]?.id as string, "approve", null);
    expect(approval.status).toBe("approved");
    expect(taskTitles(instance)).toEqual(["call the dentist"]);
    expect(helios.messages(turn.conversationId).at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("Done") });

    // An approval is used once.
    await expect(helios.decide(approval.id, "approve", null)).rejects.toThrow(/already approved/);
    expect(taskTitles(instance)).toHaveLength(1);
  });

  it("does nothing when the owner says no, or does not answer in time", async () => {
    const { instance, helios } = await setup();
    const first = await helios.handleMessage("Add a task to buy film");
    await helios.decide(first.approvals[0]?.id as string, "deny", null);

    const second = await helios.handleMessage("Add a task to scan negatives");
    instance.db.prepare("UPDATE approvals SET expires_at = ? WHERE status = 'pending'").run(new Date(Date.now() - 1000).toISOString());
    await expect(helios.decide(second.approvals[0]?.id as string, "approve", null)).rejects.toThrow(/already expired/);
    expect(taskTitles(instance)).toEqual([]);
  });

  it("runs the approved action exactly as it was approved", async () => {
    // The model asks to add one task. After the request, nothing the model
    // says can change what the approval does.
    const model = new ScriptedProvider("local", "local", [{ toolCalls: [call("add_task", { title: "Approved title", area: "inbox" })] }, { text: "Waiting for you." }]);
    const { instance, helios } = await setup([model]);
    const turn = await helios.handleMessage("Add it");
    await helios.decide(turn.approvals[0]?.id as string, "approve", null);
    expect(taskTitles(instance)).toEqual(["Approved title"]);
  });

  it("stops a model that keeps asking for tools", async () => {
    const endless = Array.from({ length: 20 }, (_, index) => ({ toolCalls: [call("get_overview", {}, `c${index}`)] }));
    const model = new ScriptedProvider("local", "local", endless);
    const { helios } = await setup([model]);
    const turn = await helios.handleMessage("Loop");
    expect(model.requests.length).toBeLessThanOrEqual(6);
    expect(turn.messages.at(-1)?.text).toContain("stopped");
  });

  it("writes every tool use and approval to an intact audit log", async () => {
    const { instance, helios } = await setup();
    const turn = await helios.handleMessage("Add a task to file the receipts");
    await helios.decide(turn.approvals[0]?.id as string, "approve", null);
    await helios.handleMessage("What is due?");
    const actions = (instance.db.prepare("SELECT action FROM audit_log ORDER BY seq").all() as { action: string }[]).map((row) => row.action);
    expect(actions).toEqual(["tool.requested", "approval.approved", "tool.run", "tool.run"]);
    expect(verifyAuditLog(instance.db).ok).toBe(true);
  });
});

describe("which model answers", () => {
  const config = defaultConfig();
  const local = new ScriptedProvider("local", "local");
  const strong = new ScriptedProvider("strong", "cloud", [], "strong");
  const light = new ScriptedProvider("light", "cloud", [], "light");
  const all = [new StandInProvider(), strong, light, local];
  const ordinary = { claudeRequested: false };
  const asked = { claudeRequested: true };
  const route = (overrides: Partial<RouteInput> = {}) => chooseProvider({ providers: all, cloudEnabled: true, task: ordinary, sensitivity: "private", egressApproved: false, capReached: false, ...overrides });

  it("picks the model on this machine unless Claude was asked for, and says why", async () => {
    expect(await route()).toMatchObject({ kind: "use", provider: { id: "local" }, reason: "an ordinary request" });
    expect(await route({ task: asked })).toMatchObject({ kind: "use", provider: { id: "strong" }, reason: "you asked for Claude" });
    // No local model running: an ordinary request is not handed to the cloud. Fixed rules answer, or nothing does.
    expect(await route({ providers: [new StandInProvider(), strong, light] })).toMatchObject({ kind: "use", provider: { id: "standin" } });
    expect(await route({ providers: [strong, light] })).toEqual({ kind: "none", reason: "The local model is not running. Claude answers only when you ask for it." });
    // Nothing real set up: the stand-in, or nothing.
    expect(await route({ providers: [new StandInProvider()] })).toMatchObject({ kind: "use", provider: { id: "standin" } });
    expect(await route({ providers: [] })).toEqual({ kind: "none", reason: "No model is set up." });
    // A model that already failed in this turn is skipped, and the answer that follows is marked as not being Claude's.
    expect(await route({ task: asked, exclude: new Set(["strong"]) })).toEqual({
      kind: "use",
      provider: local,
      reason: "you asked for Claude, but it could not answer",
      instead: "The answer below is from the model on this machine, not from Claude.",
    });
  });

  it("never uses the cloud when the data policy forbids it, also when Claude was asked for", async () => {
    // Cloud switched off: the request stays here, and the owner is told that Claude is off.
    expect(await route({ task: asked, cloudEnabled: false })).toMatchObject({
      kind: "use",
      provider: { id: "local" },
      reason: "you asked for Claude, but cloud models are switched off",
      instead: "Claude is switched off on this machine, so it was not asked. You can turn cloud models on from the main screen. The answer below is from the model on this machine.",
    });
    expect(await route({ task: asked, providers: [strong, light], cloudEnabled: false })).toEqual({
      kind: "none",
      reason: "Claude is switched off on this machine, so it was not asked. You can turn cloud models on from the main screen. No model on this machine is running either.",
    });
    // With only fixed rules on this machine, the reason under their answer still says that Claude was asked for.
    expect(await route({ task: asked, cloudEnabled: false, providers: [new StandInProvider(), strong] })).toMatchObject({
      kind: "use",
      provider: { id: "standin" },
      reason: "you asked for Claude, but cloud models are switched off; no model is connected, so fixed rules answered",
      instead: expect.stringContaining("The answer below is from fixed rules on this machine."),
    });
    // Budget used up.
    expect(await route({ task: asked, capReached: true })).toMatchObject({ kind: "use", provider: { id: "local" }, reason: expect.stringContaining("budget"), instead: expect.stringContaining("budget is used up, so Claude was not asked") });
    expect(await route({ task: asked, providers: [strong, light], capReached: true })).toMatchObject({ kind: "none", reason: expect.stringContaining("budget") });
    // Sensitive content: the owner is asked first, and only then does it go out.
    expect(await route({ task: asked, sensitivity: "sensitive" })).toMatchObject({ kind: "needs_approval", provider: { id: "strong" } });
    expect(await route({ task: asked, sensitivity: "sensitive", egressApproved: true })).toMatchObject({ kind: "use", provider: { id: "strong" } });
    // Secret content never goes to a cloud model, asked for and approved or not.
    expect(await route({ task: asked, sensitivity: "secret", egressApproved: true })).toMatchObject({ kind: "use", provider: { id: "local" }, instead: expect.stringContaining("never goes to a cloud model") });
    // Without a request none of this is even looked at: the conversation simply stays here.
    for (const sensitivity of ["normal", "private", "sensitive", "secret"] as const) {
      expect(await route({ sensitivity, egressApproved: true })).toEqual({ kind: "use", provider: local, reason: "an ordinary request" });
    }
  });

  it("prices calls on the safe side, in euros", () => {
    expect(costMicros(config, "claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(2_000_000);
    expect(costMicros(config, "claude-haiku-5-5", { inputTokens: 200_000, outputTokens: 1000 })).toBe(200_000 * 0.5 + 1000 * 2.5); // the higher rate above 100K tokens
    expect(costMicros(config, "some-new-model", { inputTokens: 0, outputTokens: 1000 })).toBe(20_000); // unknown is never free
    // The estimate assumes the whole output allowance is used, and the whole prompt written to the cache (a quarter dearer).
    expect(estimateMicros(config, "claude-sonnet-5-5", 3000, 8000)).toBe(1000 * 2 * 1.25 + 8000 * 10);
    // One request answered in two attempts (a model declined, another took over): both are on the bill, each at its own price.
    const twoAttempts = { inputTokens: 1000, outputTokens: 100, attempts: [{ model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 50 }, { model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 1000 }] };
    expect(costMicros(config, "claude-opus-5-5", twoAttempts)).toBe(1000 * 2 + 50 * 10 + (1000 * 4 * 1.25 + 100 * 20));
  });
});

describe("the cloud budget", () => {
  const cloudOnly = (script: Partial<ChatResponse>[]) => new ScriptedProvider("cloud", "cloud", script, "strong");
  /** Prices that make the arithmetic obvious: one scripted call costs 0.006 dollars, and at most 0.011 is set aside for it. */
  function cheapPrices(instance: Instance): void {
    const { cloud } = instance.config.ai;
    cloud.pricePerMTok["cloud-model"] = { input: 1, output: 10 };
    cloud.maxOutputTokens.strong = 1000;
    cloud.budget.taxAllowance = 0;
  }

  it("does not send money data to the cloud until the owner approves that conversation", async () => {
    const model = cloudOnly([{ toolCalls: [call("get_money_summary", { month: "2026-11" })] }, { text: "You made one sale." }]);
    const { instance, helios } = await setup([model], { cloud: true });

    const turn = await helios.handleMessage("Ask Claude how the shop did this month.");
    // One call went out, before anything sensitive was in the conversation.
    expect(model.requests).toHaveLength(1);
    expect(turn.approvals[0]).toMatchObject({ kind: "cloud_egress", status: "pending" });
    expect(turn.approvals[0]?.preview.some((line) => line.sensitivity === "sensitive")).toBe(true);
    expect(turn.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("approval") });

    const outcome = () => (instance.db.prepare("SELECT outcome FROM egress_log ORDER BY at, rowid").all() as { outcome: string }[]).map((row) => row.outcome);
    expect(outcome()).toEqual(["sent", "held_for_approval"]);

    const { turn: continued } = await helios.decide(turn.approvals[0]?.id as string, "approve", null);
    expect(model.requests).toHaveLength(2);
    expect(continued?.messages.at(-1)).toMatchObject({ text: "You made one sale.", model: "cloud-model", route: "you asked for Claude" });
    expect(outcome()).toEqual(["sent", "held_for_approval", "sent"]);
  });

  it("stops cloud calls at the monthly cap and says so", async () => {
    const model = cloudOnly([{ text: "one" }, { text: "two" }]);
    const { instance, helios } = await setup([model], { cloud: true });
    cheapPrices(instance);
    instance.config.ai.cloud.budget.capEur = 0.015; // room for the first call's reservation, not for a second
    await helios.handleMessage("First", { claude: true });
    const second = await helios.handleMessage("Second", { claude: true });
    expect(model.requests).toHaveLength(1);
    expect(second.messages.map((m) => m.text).join(" ")).toMatch(/cloud budget is used up, so Claude was not asked/);
    expect((instance.db.prepare("SELECT outcome FROM egress_log ORDER BY at, rowid").all() as { outcome: string }[]).map((row) => row.outcome)).toEqual(["sent", "blocked_by_cap"]);
    expect((await helios.status()).budget).toMatchObject({ capEur: 0.015, state: "ok" });
    expect((await helios.status()).budget.spentEur).toBeCloseTo(0.006, 5);
  });

  it("answers locally instead when the cap is reached", async () => {
    const cloud = cloudOnly([{ text: "from the cloud" }]);
    const local = new ScriptedProvider("local", "local", [{ text: "from this machine" }]);
    const { instance, helios } = await setup([cloud, local], { cloud: true });
    instance.config.ai.cloud.budget.capEur = 0;
    const turn = await helios.handleMessage("Ask Claude to analyse the trade-offs between the two plans.");
    expect(cloud.requests).toHaveLength(0);
    expect(turn.messages.at(-1)).toMatchObject({ text: "from this machine", model: "local-model", route: expect.stringContaining("budget") });
  });

  it("keeps its count across a restart", async () => {
    const dataDir = tempDir();
    const first = track(await openInstance({ dataDir }));
    cheapPrices(first);
    first.config.ai.cloud.allowed = true;
    await new Helios({ instance: first, providers: [cloudOnly([{ text: "one" }])], bus: new EventBus(), log: silentLogger }).handleMessage("First", { claude: true });
    const before = budgetStatus(first.db, first.config).spentEur;
    expect(before).toBeGreaterThan(0);
    first.close();

    const second = track(await openInstance({ dataDir }));
    cheapPrices(second);
    expect(budgetStatus(second.db, second.config).spentEur).toBeCloseTo(before, 9);
  });

  it("cannot be passed by two requests at once, or by a crash", async () => {
    const { instance } = await setup();
    const { db, config } = instance;
    config.ai.cloud.budget.capEur = 0.03;
    config.ai.cloud.budget.taxAllowance = 0;
    const callInfo = { provider: "cloud", model: "cloud-model", purpose: "conversation", maxSensitivity: "private" as const, bytes: 100, conversationId: null };
    // Each call may cost up to 0.02; only one fits under 0.03 at a time.
    const first = reserve(db, config, callInfo, 20_000);
    expect(first).not.toBeNull();
    expect(reserve(db, config, callInfo, 20_000)).toBeNull();
    // The first one turns out cheap, so there is room again.
    settle(db, first as string, { sent: true, tokensIn: 100, tokensOut: 50, costMicros: 1_000 });
    const second = reserve(db, config, callInfo, 20_000);
    expect(second).not.toBeNull();

    // The core dies mid-call. Afterwards the reservation counts as spent, in full.
    db.prepare("UPDATE cloud_reservations SET at = ?").run(new Date(Date.now() - 60 * 60_000).toISOString());
    expect(settleAbandoned(db)).toBe(1);
    expect(db.prepare("SELECT cost_micros, estimated FROM egress_log WHERE estimated = 1").get()).toMatchObject({ cost_micros: 20_000, estimated: 1 });
    expect(budgetStatus(db, config).spentEur).toBeCloseTo(0.021, 6);
  });

  it("warns once when spending passes the warning level", async () => {
    const model = cloudOnly([{ text: "one" }, { text: "two" }, { text: "three" }]);
    const { instance, helios } = await setup([model], { cloud: true });
    cheapPrices(instance);
    instance.config.ai.cloud.budget.warnEur = 0.005;
    const first = await helios.handleMessage("First", { claude: true });
    expect(first.messages.at(-1)?.text).toMatch(/reached €0.005 of the €20 limit/);
    const second = await helios.handleMessage("Second", { claude: true });
    expect(second.messages.map((m) => m.text).join(" ")).not.toMatch(/reached/);
    expect(warningDue(instance.db, instance.config)).toBe(false);
    expect((await helios.status()).budget.state).toBe("warning");
  });
});

describe("when a model fails", () => {
  it("does not hand the question to the cloud when the local model fails, and does not damage the conversation", async () => {
    const local = new ScriptedProvider("local", "local", [{ text: "local again" }]);
    const strong = new ScriptedProvider("strong", "cloud", [{ text: "the cloud stepped in" }], "strong");
    const light = new ScriptedProvider("light", "cloud", [{ text: "the cloud stepped in" }], "light");
    const { instance, helios } = await setup([local, strong, light], { cloud: true });
    local.failWith = new Error("connection refused, prompt was: What is due?");

    const turn = await helios.handleMessage("What is due?");
    // Cloud models are switched on and ready, and still nobody asked for Claude.
    expect(strong.requests).toHaveLength(0);
    expect(light.requests).toHaveLength(0);
    expect(turn.messages.map((m) => [m.role, m.text])).toEqual([["user", "What is due?"], ["system", "The model did not answer. Try again in a moment."]]);

    // The local model comes back; the same conversation simply continues.
    local.failWith = null;
    const next = await helios.handleMessage("And tomorrow?", { conversationId: turn.conversationId });
    expect(next.messages.at(-1)?.text).toBe("local again");
    const seqs = (instance.db.prepare("SELECT seq FROM messages WHERE conversation_id = ? ORDER BY seq").all(turn.conversationId) as { seq: number }[]).map((row) => row.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1)); // no gaps, nothing half-written
  });

  it("says so plainly when no model can answer, and logs no conversation text", async () => {
    const local = new ScriptedProvider("local", "local");
    local.failWith = new Error("timeout while sending: my private question");
    const logged: string[] = [];
    const instance = track(await openInstance({ dataDir: tempDir() }));
    const helios = new Helios({ instance, providers: [new StandInProvider(), local], bus: new EventBus(), log: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) } });
    const turn = await helios.handleMessage("my private question");
    expect(turn.messages.at(-1)).toMatchObject({ role: "system", text: "The model did not answer. Try again in a moment." });
    expect(logged.join("\n")).not.toContain("private question");
    expect(logged.join("\n")).toContain("Model local failed");
  });
});

describe("asking which model answered", () => {
  it("reports the model, the reason and the spending, from what was recorded", async () => {
    const local = new ScriptedProvider("local", "local", [
      { text: "Two things are due." },
      { toolCalls: [call("get_answer_info", {})] },
      { text: "That was the local model." },
    ]);
    const { helios } = await setup([local]);
    const { conversationId } = await helios.handleMessage("What is due?");
    await helios.handleMessage("Which model answered that?", { conversationId });
    const info = JSON.parse((local.requests.at(-1)?.messages.at(-1) as { results: { output: string }[] }).results[0]?.output as string);
    expect(info.recentAnswers[0]).toMatchObject({ model: "local-model", ranOn: "this machine", chosenBecause: "an ordinary request" });
    expect(info.cloudThisMonth).toMatchObject({ spentEur: 0, warnAtEur: 15, limitEur: 20, state: "ok" });
  });
});

describe("secrets", () => {
  it("does not pass something that looks like a password or key to any model", async () => {
    const { looksLikeSecret } = await import("../src/ai/secrets.ts");
    expect(looksLikeSecret("my password is hunter2-example")).toBe(true);
    expect(looksLikeSecret("the alarm code is 4417")).toBe(true);
    expect(looksLikeSecret("here: sk-test-0000000000000000000000")).toBe(true);
    expect(looksLikeSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecret("What is due this week?")).toBe(false);
    expect(looksLikeSecret("Remind me to change my password")).toBe(false);

    const local = new ScriptedProvider("local", "local", [{ text: "noted" }]);
    const { instance, helios } = await setup([local]);
    const turn = await helios.handleMessage("my password is hunter2-example");
    expect(local.requests).toHaveLength(0);
    expect(turn.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("marked secret") });
    expect(instance.db.prepare("SELECT sensitivity FROM messages WHERE role = 'user'").get()).toEqual({ sensitivity: "secret" });
    // Later turns in the same conversation still never show it to a model.
    await helios.handleMessage("What is due?", { conversationId: turn.conversationId });
    expect(JSON.stringify(local.requests[0]?.messages)).not.toContain("hunter2");
  });

  it("withholds anything labelled secret from every model, local ones included", async () => {
    const local = new ScriptedProvider("local", "local", [{ text: "first" }, { text: "second" }]);
    const { instance, helios } = await setup([local]);
    const { conversationId } = await helios.handleMessage("The surprise is a trip to the coast");
    // The owner marks that message secret afterwards.
    instance.db.exec("DROP TRIGGER messages_no_update");
    instance.db.prepare("UPDATE messages SET sensitivity = 'secret' WHERE role = 'user'").run();
    await helios.handleMessage("What did I just tell you?", { conversationId });
    const sent = JSON.stringify(local.requests[1]?.messages);
    expect(sent).not.toContain("trip to the coast");
    expect(sent).toContain("[withheld: marked secret]");
  });
});

describe("memory", () => {
  it("finds what was said in an earlier conversation", async () => {
    const model = new ScriptedProvider("local", "local", [
      { text: "Noted: the darkroom budget is 900 a month." },
      { text: "Understood." },
      { toolCalls: [call("search_conversations", { query: "darkroom budget" })] },
      { text: "You set it at 900 a month." },
    ]);
    const { instance, helios, events } = await setup([model]);
    await helios.handleMessage("My budget for the darkroom is 900 a month");
    await helios.handleMessage("Unrelated: remind me about the weather");
    events.length = 0;

    await helios.handleMessage("What did I decide about the darkroom budget?");
    const results = model.requests.at(-1)?.messages.at(-1);
    expect(JSON.stringify(results)).toContain("900 a month");
    expect(events).toContain("state:retrieving");
    // The hidden date note and tool traffic are not in the index.
    const indexed = instance.db.prepare("SELECT COUNT(*) AS n FROM messages_fts").get() as { n: number };
    const visible = instance.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role IN ('user', 'assistant') AND text != ''").get() as { n: number };
    expect(indexed.n).toBe(visible.n);
  });

  it("treats search input as words, never as search syntax", async () => {
    const { searchConversations, toSearchExpression } = await import("../src/ai/memory.ts");
    const { instance, helios } = await setup();
    await helios.handleMessage("What is due?");
    expect(toSearchExpression('focus" OR text:* NEAR(-x')).toBe('"focus" OR "or" OR "text" OR "near"');
    expect(() => searchConversations(instance.db, '"unbalanced AND (((')).not.toThrow();
    expect(searchConversations(instance.db, "!!! ??")).toEqual([]);
    expect(searchConversations(instance.db, "due").length).toBeGreaterThan(0); // the owner's own words are found
  });

  it("keeps a recalled sensitive passage away from the cloud until approved", async () => {
    const cloud = new ScriptedProvider("cloud", "cloud", [
      { toolCalls: [call("get_money_summary", { month: "2026-11" })] },
      { text: "Revenue was zero." },
      { toolCalls: [call("search_conversations", { query: "revenue" })] },
    ], "strong");
    const { helios } = await setup([cloud], { cloud: true });
    const first = await helios.handleMessage("How much revenue this month?", { claude: true });
    await helios.decide(first.approvals[0]?.id as string, "approve", null); // the first conversation is approved and answered

    // A new conversation recalls that sensitive answer: it must be held again.
    const second = await helios.handleMessage("What was said about revenue?", { claude: true });
    expect(second.approvals[0]).toMatchObject({ kind: "cloud_egress", status: "pending" });
  });
});
