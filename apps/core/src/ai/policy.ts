import type { Config } from "../config.ts";
import type { Db } from "../db/open.ts";
import { newId, nowIso } from "../util.ts";
import type { ModelProvider, Sensitivity } from "./types.ts";

// Which model answers, and whether a request may leave this machine.
//
// The rules, in order:
//   1. A local model is preferred when one is running (unless the owner
//      set "prefer: cloud"). Nothing leaves the machine.
//   2. A cloud model is used only when
//        - this month's spending is under the cap, and
//        - the conversation holds nothing labelled "sensitive", or the
//          owner approved sending exactly this conversation.
//      "secret" content never goes to a cloud model at all.
//   3. When the cloud would need approval and a local model is running,
//      the local model answers instead and nobody has to be asked.
//   4. The stand-in is used only when no real model is set up.

export type Route =
  | { kind: "use"; provider: ModelProvider }
  /** A cloud model could answer, but the owner has to approve sending this conversation first. */
  | { kind: "needs_approval"; provider: ModelProvider }
  | { kind: "none"; reason: string };

export async function chooseProvider(input: {
  providers: ModelProvider[];
  prefer: Config["ai"]["prefer"];
  sensitivity: Sensitivity;
  egressApproved: boolean;
  capReached: boolean;
}): Promise<Route> {
  const available: ModelProvider[] = [];
  for (const provider of input.providers) if (await provider.available()) available.push(provider);

  const real = available.filter((provider) => provider.id !== "standin");
  if (real.length === 0) {
    const standIn = available.find((provider) => provider.id === "standin");
    return standIn ? { kind: "use", provider: standIn } : { kind: "none", reason: "No model is set up." };
  }

  const local = real.filter((provider) => provider.location === "local");
  const cloud = real.filter((provider) => provider.location === "cloud");
  const ordered = input.prefer === "cloud" ? [...cloud, ...local] : [...local, ...cloud];

  let held: ModelProvider | null = null;
  let blocked = "";
  for (const provider of ordered) {
    if (provider.location === "local") return { kind: "use", provider };
    if (input.capReached) {
      blocked = "This month's cloud budget is used up.";
      continue;
    }
    if (input.sensitivity === "secret") {
      blocked = "This conversation contains something that never goes to a cloud model.";
      continue;
    }
    if (input.sensitivity === "sensitive" && !input.egressApproved) {
      held ??= provider;
      continue;
    }
    return { kind: "use", provider };
  }
  if (held) return { kind: "needs_approval", provider: held };
  return { kind: "none", reason: `${blocked} No local model is running.`.trim() };
}

// ---------- the record of cloud calls, and what they cost ----------

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Cloud spending in the current calendar month, in millionths of a US dollar. */
export function monthSpendMicros(db: Db, now: Date = new Date()): number {
  const row = db.prepare("SELECT COALESCE(SUM(cost_micros), 0) AS total FROM egress_log WHERE outcome = 'sent' AND at >= ?").get(monthStart(now)) as { total: number };
  return row.total;
}

export function capReached(db: Db, config: Config, now: Date = new Date()): boolean {
  return monthSpendMicros(db, now) >= config.ai.cloud.monthlyCapUsd * 1_000_000;
}

/** What one call cost. An unknown model is priced like the most expensive known one, never as free. */
export function costMicros(config: Config, model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const prices = config.ai.cloud.pricePerMTok;
  const price = prices[model] ?? Object.values(prices).sort((a, b) => b.output - a.output)[0] ?? { input: 0, output: 0 };
  return Math.round(usage.inputTokens * price.input + usage.outputTokens * price.output);
}

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
    outcome: "sent" | "held_for_approval" | "blocked_by_cap" | "failed";
    approvalId?: string | null;
    conversationId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO egress_log (id, at, provider, model, purpose, max_sensitivity, bytes, tokens_in, tokens_out, cost_micros, outcome, approval_id, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    nowIso(),
    entry.provider,
    entry.model,
    entry.purpose,
    entry.maxSensitivity,
    entry.bytes,
    entry.tokensIn ?? 0,
    entry.tokensOut ?? 0,
    entry.costMicros ?? 0,
    entry.outcome,
    entry.approvalId ?? null,
    entry.conversationId ?? null,
  );
}
