import { describe, expect, it } from "vitest";
import { Helios } from "../src/ai/helios.ts";
import { chooseProvider, costMicros } from "../src/ai/policy.ts";
import { StandInProvider } from "../src/ai/standin.ts";
import { toolSpecs } from "../src/ai/tools.ts";
import type { ChatRequest, ChatResponse, ModelProvider } from "../src/ai/types.ts";
import { defaultConfig } from "../src/config.ts";
import { EventBus } from "../src/events.ts";
import { type Instance, openInstance } from "../src/instance.ts";
import { verifyAuditLog } from "../src/security/audit.ts";
import { silentLogger } from "../src/util.ts";
import { insertTask, taskTitles, tempDir, track } from "./helpers.ts";

/** A model that answers exactly what the test scripted, and records what it was sent. */
class ScriptedProvider implements ModelProvider {
  readonly id: string;
  readonly location: "local" | "cloud";
  readonly model: string;
  readonly requests: ChatRequest[] = [];
  private script: Partial<ChatResponse>[];
  isAvailable = true;

  constructor(id: string, location: "local" | "cloud", script: Partial<ChatResponse>[] = []) {
    this.id = id;
    this.location = location;
    this.model = `${id}-model`;
    this.script = script;
  }
  async available() {
    return this.isAvailable;
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone({ ...request, onText: undefined }));
    const next = this.script.shift() ?? { text: "ok" };
    return { text: "", toolCalls: [], stop: next.toolCalls?.length ? "tool_use" : "end", usage: { inputTokens: 1000, outputTokens: 500 }, model: this.model, ...next };
  }
}

const call = (name: string, input: unknown, id = "c1") => ({ id, name, input });

async function setup(providers: ModelProvider[] = [new StandInProvider()]): Promise<{ instance: Instance; helios: Helios; events: string[] }> {
  const instance = track(await openInstance({ dataDir: tempDir() }));
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
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
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

describe("local or cloud", () => {
  const config = defaultConfig();
  const local = new ScriptedProvider("local", "local");
  const cloud = new ScriptedProvider("cloud", "cloud");
  const route = (overrides: Partial<Parameters<typeof chooseProvider>[0]> = {}) =>
    chooseProvider({ providers: [new StandInProvider(), cloud, local], prefer: "auto", sensitivity: "private", egressApproved: false, capReached: false, ...overrides });

  it("prefers the local model, and the stand-in only when nothing else exists", async () => {
    expect(await route()).toMatchObject({ kind: "use", provider: { id: "local" } });
    expect(await route({ providers: [new StandInProvider()] })).toMatchObject({ kind: "use", provider: { id: "standin" } });
    expect(await route({ prefer: "cloud" })).toMatchObject({ kind: "use", provider: { id: "cloud" } });
  });

  it("answers sensitive conversations locally instead of asking, when it can", async () => {
    expect(await route({ prefer: "cloud", sensitivity: "sensitive" })).toMatchObject({ kind: "use", provider: { id: "local" } });
  });

  it("holds sensitive conversations for approval when only the cloud can answer", async () => {
    const onlyCloud = { providers: [new StandInProvider(), cloud] };
    expect(await route({ ...onlyCloud, sensitivity: "sensitive" })).toMatchObject({ kind: "needs_approval" });
    expect(await route({ ...onlyCloud, sensitivity: "sensitive", egressApproved: true })).toMatchObject({ kind: "use", provider: { id: "cloud" } });
    expect(await route({ ...onlyCloud, sensitivity: "secret", egressApproved: true })).toMatchObject({ kind: "none" });
    expect(await route({ ...onlyCloud, capReached: true })).toMatchObject({ kind: "none", reason: expect.stringContaining("budget") });
  });

  it("prices a call, and never prices an unknown model as free", () => {
    expect(costMicros(config, "claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4_000_000);
    expect(costMicros(config, "some-new-model", { inputTokens: 0, outputTokens: 1000 })).toBe(20_000);
  });

  it("does not send money data to the cloud until the owner approves that conversation", async () => {
    const model = new ScriptedProvider("cloud", "cloud", [
      { toolCalls: [call("get_money_summary", { month: "2026-11" })] },
      { text: "You made one sale." },
    ]);
    const { instance, helios } = await setup([model]);

    const turn = await helios.handleMessage("How did the shop do this month?");
    // One call went out, before anything sensitive was in the conversation.
    expect(model.requests).toHaveLength(1);
    expect(turn.approvals[0]).toMatchObject({ kind: "cloud_egress", status: "pending" });
    expect(turn.approvals[0]?.preview.some((line) => line.sensitivity === "sensitive")).toBe(true);
    expect(turn.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("approval") });

    const outcome = () => (instance.db.prepare("SELECT outcome FROM egress_log ORDER BY at, rowid").all() as { outcome: string }[]).map((row) => row.outcome);
    expect(outcome()).toEqual(["sent", "held_for_approval"]);

    const { turn: continued } = await helios.decide(turn.approvals[0]?.id as string, "approve", null);
    expect(model.requests).toHaveLength(2);
    expect(continued?.messages.at(-1)?.text).toBe("You made one sale.");
    expect(outcome()).toEqual(["sent", "held_for_approval", "sent"]);
  });

  it("stops using the cloud when the monthly cap is reached", async () => {
    const model = new ScriptedProvider("cloud", "cloud", [{ text: "one" }, { text: "two" }]);
    const { instance, helios } = await setup([model]);
    instance.config.ai.cloud.monthlyCapUsd = 0.01; // one call of 1000 in + 500 out tokens costs more than this
    await helios.handleMessage("First");
    const second = await helios.handleMessage("Second");
    expect(model.requests).toHaveLength(1);
    expect(second.messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("budget") });
    expect((await helios.status()).cloudSpendUsd).toBeGreaterThan(0.01);
  });
});
