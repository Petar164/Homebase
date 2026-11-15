import type { Config } from "../config.ts";
import { type Db, transaction } from "../db/open.ts";
import { newId, nowIso } from "../util.ts";
import type { ModelProvider, ProviderRole, Sensitivity } from "./types.ts";

// Which model answers, whether a request may leave this machine, and what
// it may cost. Every decision here is a fixed rule, not a model's judgement,
// so the same request always takes the same route and the reason can be
// stated.
//
// THE ROUTE, for a conversation:
//   1. The owner asked for stronger reasoning  → the strong cloud model.
//   2. The request is long or analytical        → the strong cloud model.
//   3. Everything else                          → the local model.
//   4. No local model running                   → the light cloud model.
// Background work (extraction, summaries) goes to the light cloud model,
// then the local one.
//
// A cloud model is only ever used when ALL of these hold:
//   - cloud use is switched on (the data-policy switch)
//   - this month's budget has room for the call
//   - nothing labelled "secret" is involved (that never goes to any model)
//   - nothing labelled "sensitive" is involved, or the owner approved
//     sending exactly this conversation
// When a rule blocks the cloud, the local model answers instead and says
// why. The cloud is never used "anyway".

// ---------- what kind of request is this? ----------

export type Task = {
  /** The owner explicitly asked for the stronger model. */
  strongRequested: boolean;
  /** Long or analytical, by the fixed criteria below. */
  complex: boolean;
};

const STRONG_REQUEST = /\b(think (hard|harder|deeply|carefully|it through)|use (the |your )?(strong(er|est)?|best|bigger|cloud|smart(er|est)?) (model|brain|reasoning)|use sonnet|deep(er)? (analysis|reasoning|dive))\b/i;
const ANALYTICAL = /\b(analy[sz]e|analysis|compare|comparison|trade-?offs?|pros and cons|strategy|strategic|evaluate|step[- ]by[- ]step|in detail|in depth|architecture|root cause|write (a|an|the) (report|essay|proposal|plan)|plan (out|for) (the|my|a)|review my)\b/i;

export function classifyRequest(text: string, config: Config, override?: "strong"): Task {
  const strongRequested = override === "strong" || STRONG_REQUEST.test(text);
  return { strongRequested, complex: strongRequested || text.length > config.ai.routing.complexChars || ANALYTICAL.test(text) };
}

// ---------- choosing the model ----------

export type Route =
  | { kind: "use"; provider: ModelProvider; reason: string }
  /** A cloud model should answer, but the owner has to approve sending this conversation first. */
  | { kind: "needs_approval"; provider: ModelProvider; reason: string }
  | { kind: "none"; reason: string };

export type RouteInput = {
  providers: ModelProvider[];
  prefer: Config["ai"]["prefer"];
  /** The data-policy switch. */
  cloudEnabled: boolean;
  purpose: "conversation" | "background";
  task: Task;
  sensitivity: Sensitivity;
  egressApproved: boolean;
  /** True when this month's budget has no room left. */
  capReached: boolean;
  /** Providers that already failed in this turn. */
  exclude?: Set<string>;
};

export async function chooseProvider(input: RouteInput): Promise<Route> {
  const byRole = new Map<ProviderRole, ModelProvider>();
  for (const provider of input.providers) {
    if (!input.exclude?.has(provider.id) && !byRole.has(provider.role) && (await provider.available())) byRole.set(provider.role, provider);
  }
  const local = byRole.get("local");
  const strong = byRole.get("strong");
  const light = byRole.get("light");
  if (!local && !strong && !light) {
    const standIn = byRole.get("standin");
    return standIn ? { kind: "use", provider: standIn, reason: "no model is connected, so fixed rules answered" } : { kind: "none", reason: "No model is set up." };
  }

  // Why the cloud may not be used at all right now, if it may not.
  const blocked = !input.cloudEnabled
    ? "cloud models are switched off"
    : input.capReached
      ? "this month's cloud budget is used up"
      : input.sensitivity === "secret"
        ? "this conversation holds something that never goes to a cloud model"
        : null;
  const needsApproval = input.sensitivity === "sensitive" && !input.egressApproved;
  const useLocal = (reason: string): Route | null => (local ? { kind: "use", provider: local, reason } : null);

  let result: Route | null = null;
  if (input.purpose === "background") {
    // Background work never interrupts the owner with a question.
    if (light && !blocked && !needsApproval) result = { kind: "use", provider: light, reason: "background work" };
    result ??= useLocal(blocked ? `background work, kept local: ${blocked}` : needsApproval ? "background work, kept local: sensitive content" : "background work");
    return result ?? { kind: "none", reason: blocked ? `Not done: ${blocked}, and no local model is running.` : "Not done: this needs approval, and no local model is running." };
  }

  const { strongRequested, complex } = input.task;
  if (strongRequested) {
    // Rule 1. An explicit request is honoured if the rules allow it, and if
    // it involves sensitive content the owner is asked, not second-guessed.
    if (strong && !blocked) {
      return needsApproval
        ? { kind: "needs_approval", provider: strong, reason: "you asked for stronger reasoning, and this conversation holds sensitive content" }
        : { kind: "use", provider: strong, reason: "you asked for stronger reasoning" };
    }
    result = useLocal(`the stronger model was not used: ${blocked ?? "no cloud model is set up"}`);
  } else if (complex && input.prefer !== "local") {
    // Rule 2. Sensitive content does not trigger a question here: the local
    // model answers, and the owner can still ask for the stronger one.
    if (strong && !blocked && !needsApproval) return { kind: "use", provider: strong, reason: "a long or analytical request" };
    result = useLocal(blocked ? `kept local: ${blocked}` : needsApproval ? "kept local: sensitive content stays on this machine" : "a long or analytical request, and no cloud model is set up");
    if (!result && strong && !blocked) return { kind: "needs_approval", provider: strong, reason: "this conversation holds sensitive content, and no local model is running" };
  } else if (input.prefer === "cloud" && light && !blocked && !needsApproval) {
    return { kind: "use", provider: light, reason: "an ordinary request, and cloud models are preferred" };
  }

  // Rules 3 and 4.
  result ??= useLocal(complex ? "a long or analytical request, kept local by preference" : "an ordinary request");
  if (result) return result;
  const cloud = light ?? strong;
  if (cloud && !blocked) {
    return needsApproval
      ? { kind: "needs_approval", provider: cloud, reason: "this conversation holds sensitive content, and no local model is running" }
      : { kind: "use", provider: cloud, reason: "the local model is not running" };
  }
  return { kind: "none", reason: `${blocked ? `${blocked[0]?.toUpperCase()}${blocked.slice(1)}` : "No cloud model is set up"}, and no local model is running.` };
}

// ---------- the budget ----------
//
// Prices are in US dollars and the budget is in euros. Converting on the
// safe side (see config.ai.cloud.budget) means the real bill should come
// out under what is counted here, never over.

type Price = Config["ai"]["cloud"]["pricePerMTok"][string];

function priceFor(config: Config, model: string, inputTokens: number): { input: number; output: number } {
  const prices = config.ai.cloud.pricePerMTok;
  // An unknown model is priced like the most expensive known one, never as free.
  const price: Price = prices[model] ?? Object.values(prices).sort((a, b) => b.output - a.output)[0] ?? { input: 0, output: 0 };
  const large = inputTokens > 100_000;
  return { input: (large && price.inputAbove100k) || price.input, output: (large && price.outputAbove100k) || price.output };
}

/** The most a call can cost, in millionths of a dollar: the whole prompt plus the full output allowance. */
export function estimateMicros(config: Config, model: string, promptBytes: number, maxOutputTokens: number): number {
  // Three bytes per token is on the high side for English, on purpose.
  const inputTokens = Math.ceil(promptBytes / 3);
  const price = priceFor(config, model, inputTokens);
  return Math.ceil(inputTokens * price.input + maxOutputTokens * price.output);
}

/** What a call did cost, from the usage the provider reported. */
export function costMicros(config: Config, model: string, usage: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number }): number {
  const price = priceFor(config, model, usage.inputTokens);
  // Writing to the provider's cache is billed 25% above the normal input rate.
  return Math.ceil(usage.inputTokens * price.input + (usage.cacheWriteTokens ?? 0) * price.input * 0.25 + usage.outputTokens * price.output);
}

export function microsToEur(config: Config, micros: number): number {
  const { usdToEur, taxAllowance } = config.ai.cloud.budget;
  return (micros / 1_000_000) * usdToEur * (1 + taxAllowance);
}

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type Budget = { spentEur: number; reservedEur: number; warnEur: number; capEur: number; state: "ok" | "warning" | "capped" };

/** Where this month's cloud spending stands. Read from the database, so it survives restarts. */
export function budgetStatus(db: Db, config: Config, now: Date = new Date()): Budget {
  const spent = db.prepare("SELECT COALESCE(SUM(cost_micros), 0) AS total FROM egress_log WHERE outcome = 'sent' AND at >= ?").get(monthStart(now)) as { total: number };
  const reserved = db.prepare("SELECT COALESCE(SUM(estimate_micros), 0) AS total FROM cloud_reservations").get() as { total: number };
  const { warnEur, capEur } = config.ai.cloud.budget;
  const spentEur = microsToEur(config, spent.total);
  const reservedEur = microsToEur(config, reserved.total);
  const state = spentEur + reservedEur >= capEur ? "capped" : spentEur >= warnEur ? "warning" : "ok";
  return { spentEur, reservedEur, warnEur, capEur, state };
}

type Call = { provider: string; model: string; purpose: string; maxSensitivity: Sensitivity; bytes: number; conversationId: string | null };

/**
 * Sets money aside for a cloud call before it is made. Returns null when
 * the call's worst-case cost would take the month past the cap: then the
 * call must not be made. Checking and reserving happen in one transaction,
 * so requests running at the same time cannot both squeeze under the cap.
 */
export function reserve(db: Db, config: Config, call: Call, estimate: number, now: Date = new Date()): string | null {
  return transaction(db, () => {
    const budget = budgetStatus(db, config, now);
    if (budget.spentEur + budget.reservedEur + microsToEur(config, estimate) > budget.capEur) return null;
    const id = newId();
    db.prepare("INSERT INTO cloud_reservations (id, at, provider, model, purpose, max_sensitivity, bytes, estimate_micros, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      now.toISOString(),
      call.provider,
      call.model,
      call.purpose,
      call.maxSensitivity,
      call.bytes,
      estimate,
      call.conversationId,
    );
    return id;
  });
}

/** Replaces a reservation with what really happened. */
export function settle(db: Db, reservationId: string, outcome: { sent: true; tokensIn: number; tokensOut: number; costMicros: number } | { sent: false }): void {
  transaction(db, () => {
    const row = db.prepare("SELECT provider, model, purpose, max_sensitivity, bytes, conversation_id FROM cloud_reservations WHERE id = ?").get(reservationId) as
      | { provider: string; model: string; purpose: string; max_sensitivity: Sensitivity; bytes: number; conversation_id: string | null }
      | undefined;
    if (!row) return;
    db.prepare("DELETE FROM cloud_reservations WHERE id = ?").run(reservationId);
    recordEgress(db, {
      provider: row.provider,
      model: row.model,
      purpose: row.purpose,
      maxSensitivity: row.max_sensitivity,
      bytes: row.bytes,
      conversationId: row.conversation_id,
      ...(outcome.sent ? { outcome: "sent", tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut, costMicros: outcome.costMicros } : { outcome: "failed" }),
    });
  });
}

/**
 * Reservations left behind by a crash. The call may well have been billed,
 * so each one is recorded as sent, at its full estimate, marked as an
 * estimate. Erring towards "it cost money" keeps the cap honest.
 */
export function settleAbandoned(db: Db, now: Date = new Date(), olderThanMinutes = 15): number {
  const before = new Date(now.getTime() - olderThanMinutes * 60_000).toISOString();
  const rows = db.prepare("SELECT id, at, provider, model, purpose, max_sensitivity, bytes, estimate_micros, conversation_id FROM cloud_reservations WHERE at < ?").all(before) as {
    id: string; at: string; provider: string; model: string; purpose: string; max_sensitivity: Sensitivity; bytes: number; estimate_micros: number; conversation_id: string | null;
  }[];
  transaction(db, () => {
    for (const row of rows) {
      db.prepare("DELETE FROM cloud_reservations WHERE id = ?").run(row.id);
      recordEgress(db, { provider: row.provider, model: row.model, purpose: row.purpose, maxSensitivity: row.max_sensitivity, bytes: row.bytes, conversationId: row.conversation_id, outcome: "sent", costMicros: row.estimate_micros, estimated: true, at: row.at });
    }
  });
  return rows.length;
}

/** True exactly once per calendar month: the first time spending is at or past the warning level. */
export function warningDue(db: Db, config: Config, now: Date = new Date()): boolean {
  if (budgetStatus(db, config, now).spentEur < config.ai.cloud.budget.warnEur) return false;
  const month = now.toISOString().slice(0, 7);
  const last = db.prepare("SELECT value FROM meta WHERE key = 'cloud_warned_month'").get() as { value: string } | undefined;
  if (last?.value === month) return false;
  db.prepare("INSERT INTO meta (key, value) VALUES ('cloud_warned_month', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(month);
  return true;
}

/** Appends to the record of what left this machine, or was stopped from leaving. */
export function recordEgress(
  db: Db,
  entry: {
    provider: string;
    model: string;
    purpose: string;
    maxSensitivity: Sensitivity;
    bytes: number;
    tokensIn?: number;
    tokensOut?: number;
    costMicros?: number;
    estimated?: boolean;
    outcome: "sent" | "held_for_approval" | "blocked_by_cap" | "failed";
    approvalId?: string | null;
    conversationId?: string | null;
    at?: string;
  },
): void {
  db.prepare(
    `INSERT INTO egress_log (id, at, provider, model, purpose, max_sensitivity, bytes, tokens_in, tokens_out, cost_micros, estimated, outcome, approval_id, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    entry.at ?? nowIso(),
    entry.provider,
    entry.model,
    entry.purpose,
    entry.maxSensitivity,
    entry.bytes,
    entry.tokensIn ?? 0,
    entry.tokensOut ?? 0,
    entry.costMicros ?? 0,
    entry.estimated ? 1 : 0,
    entry.outcome,
    entry.approvalId ?? null,
    entry.conversationId ?? null,
  );
}
