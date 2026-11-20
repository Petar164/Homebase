import type { Config } from "../config.ts";
import { type Db, transaction } from "../db/open.ts";
import { newId, nowIso } from "../util.ts";
import type { AttemptUsage, ChatResponse, ModelProvider, ProviderRole, Sensitivity } from "./types.ts";

// Which model answers, whether a request may leave this machine, and what
// it may cost. Every decision here is a fixed rule, not a model's judgement,
// so the same request always takes the same route and the reason can be
// stated.
//
// THE ROUTE:
//   1. The owner asked for Claude for this one message, in so many words
//      or with the screen's "Ask Claude"   → Claude, if every condition
//                                             below holds.
//   2. Everything else                      → the model on this machine.
//
// HELIOS is local first. Nothing but rule 1 leads to a cloud model: not a
// long or difficult question, not a missing or failing local model, not a
// setting, not background work. Switching cloud models on makes Claude
// available to be asked for. It does not make HELIOS choose it.
//
// When Claude is asked for, it is used only when ALL of these hold:
//   - cloud use is switched on (the data-policy switch, off until the
//     owner turns it on; a key alone does not switch anything on)
//   - a usable key is set
//   - this month's budget has room for the call
//   - nothing labelled "secret" is involved (that never goes to any model)
//   - nothing labelled "sensitive" is involved, or the owner approved
//     sending exactly this conversation
// When one of them fails, the model on this machine answers instead, under
// its own name, and HELIOS says first why Claude is not the one answering.

// ---------- did the owner ask for Claude? ----------

/** What one message asks for. `claudeRequested` is the only thing that can lead to a cloud model. */
export type Task = { claudeRequested: boolean };

// The owner's words count as a request for Claude only when the message
// BEGINS with a command that names Claude: "Ask Claude ...", "Use Claude
// ...", and the few forms below. Only the beginning is read. Whatever
// comes later in a message is not searched: not a later sentence, not the
// second half of a sentence, not text that was pasted in. So a mention, a
// question about Claude, "should I ask Claude?", "don't, whatever you do,
// ask Claude" and a pasted article that ends in "Try Claude today" are not
// requests.
//
// The list is fixed and short on purpose: the same words always decide the
// same way, and no model is asked what the owner meant. A request that is
// not recognised stays on this machine, which is the safe side to fail on,
// and HELIOS says so when the words came close (`namesClaudeInACommand`).

/**
 * The name, and the spellings a speech recogniser may give it. Never the
 * ordinary word "cloud". Not the name of another product or of something
 * that belongs to the service ("Claude Code", "Claude's API key", "Claude
 * Max"), and not the best-known people of that name.
 */
const NAME = String.raw`(?:claude|claud|clawd|klaude|klaud)\b(?!(?:'s)?\s+(?:code|desktop|app|api|sdk|console|account|subscription|max|pro|keys?|docs|pricing|prices?|models?|limits?|terms|shannon|monet|debussy)\b|\.ai\b)`;
/** Words that may come before a command without changing what it is. A sentence of nothing else ("Helios.", "Helios?", "Thanks.") is passed over. */
const OPENERS = String.raw`hey|hi|hello|ok|okay|so|now|then|and|but|well|right|yes|yeah|no|thanks|thank you|great|good|fine|sure|alright|actually|instead|please|kindly|just|also`;
const ASKING_NICELY = String.raw`(?:can|could|would|will) you|(?:can|could) we`;
const LEAD = String.raw`(?:(?:${OPENERS})\b[\s,]*|helios\b[\s,:]*|(?:${ASKING_NICELY})\b(?: please)?[\s,]*|(?:i want|i need|i'd like|i would like)(?: you)? to\b[\s,]*|(?:let's|let us)\b[\s,]*|go ahead and\b[\s,]*)*`;
const THING = String.raw`(?:this|that|it|these|those|them|(?:the|my|our) \w+(?: \w+)?)`;
/** Work that can be done together with someone. */
const WORK_WITH = String.raw`(?:answer|do|check|double-check|try|solve|analy[sz]e|review|summari[sz]e|write|rewrite|draft|plan|evaluate|assess|research|translate|proofread|debug|fix|verify|calculate|decide|brainstorm|critique|examine|investigate|read|find|handle|run|think (?:about|through|over)|look (?:at|into|over)|work (?:on|out|through)|figure out|go (?:over|through))`;
/** The same, and what can be done by means of something. "Compare this with Claude" compares the two; "compare this using Claude" asks for it. */
const WORK = String.raw`(?:${WORK_WITH}|compare|explain|tell me|show me|give me|help me)`;

/** The command forms, each with the name it is recorded under. */
const FORMS: [name: string, pattern: string][] = [
  ["ask", String.raw`ask ${NAME}`],
  ["use", String.raw`(?:use|try) ${NAME}`],
  ["let", String.raw`(?:let|have) ${NAME} \w+`],
  ["get", String.raw`get ${NAME} to \w+`],
  ["send", String.raw`(?:send|give|pass|hand|forward|show|take|put|run) ${THING} (?:over )?(?:to|by|past|through) ${NAME}`],
  ["switch", String.raw`(?:switch|go|move|change|escalate|turn)(?: over)? to ${NAME}`],
  ["with", String.raw`${WORK_WITH}(?: ${THING})? with ${NAME}`],
  ["using", String.raw`${WORK}(?: ${THING})? (?:using|via) ${NAME}`],
  ["want", String.raw`(?:i want|i need|i'd like|i would like|give me|get me|bring in|call in) ${NAME}`],
];
/** A command, where a message begins. */
const COMMANDS = FORMS.map(([name, pattern]) => [name, new RegExp(`^${LEAD}(?:${pattern})(.*)$`, "i")] as const);
/** The same forms, anywhere in a message. */
const SOMEWHERE = new RegExp(String.raw`\b(?:${FORMS.map(([, pattern]) => pattern).join("|")})`, "i");
const ONLY_OPENERS = new RegExp(String.raw`^(?:(?:${OPENERS}|helios)\b[\s,.!?]*)+$`, "i");
const NICELY = new RegExp(String.raw`^(?:(?:${OPENERS})\b[\s,]*|helios\b[\s,:]*)*(?:${ASKING_NICELY})\b`, "i");

const plain = (text: string) => text.replace(/[’`]/g, "'");

/**
 * Whether these words tell HELIOS to use Claude, and by which form. Null
 * when they do not. The same check reads what was typed and what was
 * spoken.
 */
export function claudeRequestIn(text: string): string | null {
  // The beginning of the message: its first sentence, after a greeting.
  const first = plain(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => sentence && !ONLY_OPENERS.test(sentence));
  if (!first) return null;
  const question = first.endsWith("?");
  const said = first.replace(/[.!?]+$/, "");
  for (const [name, command] of COMMANDS) {
    const match = command.exec(said);
    if (!match) continue;
    // "Ask Claude?" wonders whether to. "Can you ask Claude?" and "Ask Claude what is due?" are requests.
    if (question && !NICELY.test(said) && !(match[1] ?? "").trim()) continue;
    return name;
  }
  return null;
}

/**
 * True when the words hold a command that names Claude anywhere. When such
 * a message is not a request by the rule above, HELIOS says that it was
 * not taken as one, so that the owner does not take the answer for
 * Claude's and learns how to ask.
 */
export function namesClaudeInACommand(text: string): boolean {
  return SOMEWHERE.test(plain(text));
}

// ---------- choosing the model ----------

export type Route =
  | {
      kind: "use";
      provider: ModelProvider;
      reason: string;
      /** Set when Claude was asked for and another model answers: the sentence that says why, to be shown and spoken before the answer. */
      instead?: string;
    }
  /** Claude was asked for, but the owner has to approve sending this conversation first. */
  | { kind: "needs_approval"; provider: ModelProvider; reason: string }
  | { kind: "none"; reason: string };

export type RouteInput = {
  providers: ModelProvider[];
  /** The data-policy switch. */
  cloudEnabled: boolean;
  task: Task;
  sensitivity: Sensitivity;
  egressApproved: boolean;
  /** True when this month's budget has no room left. */
  capReached: boolean;
  /** Providers that already failed in this turn. */
  exclude?: Set<string>;
};

export async function chooseProvider(input: RouteInput): Promise<Route> {
  const usable = new Map<ProviderRole, ModelProvider>();
  for (const provider of input.providers) {
    if (!input.exclude?.has(provider.id) && !usable.has(provider.role) && (await provider.available())) usable.set(provider.role, provider);
  }
  const local = usable.get("local");
  const standIn = usable.get("standin");
  const cloudIsSetUp = input.providers.some((provider) => provider.location === "cloud");

  /** What answers on this machine: the local model, or fixed rules while no local model exists. */
  const onThisMachine = (reason: string, nothing: string): Route => {
    if (local) return { kind: "use", provider: local, reason };
    const fixedRules = "no model is connected, so fixed rules answered";
    // The reason under an answer always says so when Claude was asked for and did not write it.
    return standIn ? { kind: "use", provider: standIn, reason: input.task.claudeRequested ? `${reason}; ${fixedRules}` : fixedRules } : { kind: "none", reason: nothing };
  };

  // THE ONE DOOR TO THE CLOUD. Without the owner's own request for Claude,
  // for this message, no cloud provider is looked at, whatever else is true.
  if (!input.task.claudeRequested) {
    return onThisMachine("an ordinary request", cloudIsSetUp ? "The local model is not running. Claude answers only when you ask for it." : "No model is set up.");
  }

  // Claude was asked for. It answers only if every condition holds; the
  // first one that does not is told to the owner in a sentence.
  const claude = usable.get("strong");
  const configured = input.providers.find((provider) => provider.role === "strong");
  const failed = configured !== undefined && input.exclude?.has(configured.id) === true;
  const notSetUp = configured?.describe?.().problem ?? (configured ? "it is not available" : "no cloud model is part of this installation");
  const [short, sentence] = !input.cloudEnabled
    ? ["cloud models are switched off", "Claude is switched off on this machine, so it was not asked. You can turn cloud models on from the main screen."]
    : failed
      ? ["it could not answer", null] // the turn loop has already said what went wrong
      : !claude
        ? ["Claude is not set up", `Claude cannot be asked: ${notSetUp}.`]
        : input.capReached
          ? ["this month's cloud budget is used up", "This month's cloud budget is used up, so Claude was not asked."]
          : input.sensitivity === "secret"
            ? ["this conversation holds something that never goes to a cloud model", "This conversation holds something that never goes to a cloud model, so Claude was not asked."]
            : [null, null];

  if (short === null && claude) {
    // If the conversation holds sensitive content the owner is asked, not second-guessed.
    return input.sensitivity === "sensitive" && !input.egressApproved
      ? { kind: "needs_approval", provider: claude, reason: "you asked for Claude, and this conversation holds sensitive content" }
      : { kind: "use", provider: claude, reason: "you asked for Claude" };
  }
  const fallback = onThisMachine(`you asked for Claude, but ${short}`, `${sentence ?? "Claude could not answer."} No model on this machine is running either.`);
  if (fallback.kind !== "use") return fallback;
  // The answer that follows is not Claude's, and it must not pass for it.
  const who = fallback.provider.role === "standin" ? "fixed rules on this machine" : "the model on this machine";
  return { ...fallback, instead: sentence ? `${sentence} The answer below is from ${who}.` : `The answer below is from ${who}, not from Claude.` };
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

/** Writing to the provider's cache is billed this much above the normal input rate. */
const CACHE_WRITE_SURCHARGE = 0.25;

/**
 * The most a call can cost, in millionths of a dollar: the whole prompt,
 * counted as if all of it were written to the cache, plus the full output
 * allowance.
 */
export function estimateMicros(config: Config, model: string, promptBytes: number, maxOutputTokens: number): number {
  // Three bytes per token is on the high side for English, on purpose.
  const inputTokens = Math.ceil(promptBytes / 3);
  const price = priceFor(config, model, inputTokens);
  return Math.ceil(inputTokens * price.input * (1 + CACHE_WRITE_SURCHARGE) + maxOutputTokens * price.output);
}

/**
 * What a call did cost, from the usage the provider reported. When the
 * provider answered in more than one attempt (one model declined, another
 * took over), every attempt is counted, each at its own model's price.
 */
export function costMicros(config: Config, model: string, usage: ChatResponse["usage"]): number {
  const one = (attempt: AttemptUsage): number => {
    const price = priceFor(config, attempt.model, attempt.inputTokens);
    return attempt.inputTokens * price.input + (attempt.cacheWriteTokens ?? 0) * price.input * CACHE_WRITE_SURCHARGE + attempt.outputTokens * price.output;
  };
  const attempts = usage.attempts?.length ? usage.attempts : [{ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheWriteTokens: usage.cacheWriteTokens }];
  return Math.ceil(attempts.reduce((sum, attempt) => sum + one(attempt), 0));
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

/**
 * Replaces a reservation with what really happened.
 *
 * A call that failed before the provider began to answer cost nothing. One
 * that failed after that (`mayBeBilled`) may be on the bill although
 * nothing usable came back, and nobody here knows for how much. It is then
 * counted at its full estimate, marked as an estimate: the same rule as for
 * a call cut short by a crash (settleAbandoned).
 */
export function settle(db: Db, reservationId: string, outcome: { sent: true; tokensIn: number; tokensOut: number; costMicros: number } | { sent: false; mayBeBilled?: boolean }): void {
  transaction(db, () => {
    const row = db.prepare("SELECT provider, model, purpose, max_sensitivity, bytes, estimate_micros, conversation_id FROM cloud_reservations WHERE id = ?").get(reservationId) as
      | { provider: string; model: string; purpose: string; max_sensitivity: Sensitivity; bytes: number; estimate_micros: number; conversation_id: string | null }
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
      ...(outcome.sent
        ? { outcome: "sent", tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut, costMicros: outcome.costMicros }
        : outcome.mayBeBilled
          ? { outcome: "sent", costMicros: row.estimate_micros, estimated: true }
          : { outcome: "failed" }),
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
