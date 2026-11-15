import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider, ToolResult } from "./types.ts";

// A stand-in for a language model: a handful of fixed rules, no
// intelligence. It exists so that everything around the model (the
// conversation, tools, permissions, the screen) works and can be tested
// before a real model is connected. It goes through exactly the same tool
// and approval path a real model does.

const HELP =
  "I am running without a language model for now, so I only understand a few requests: " +
  '"what is due", "list my tasks", "add a task ...", and "money this month". ' +
  "Connect a model to talk freely.";

function lastUserText(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return message.text;
  }
  return "";
}

function parse(result: ToolResult): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(result.output);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Turns one tool result into a sentence. */
function describe(result: ToolResult): string {
  if (result.isError) return `That did not work: ${result.output}`;
  const data = parse(result);
  if (data.status === "waiting_for_owner") return `${String(data.summary)}. Confirm on screen and I will do it.`;

  if (result.name === "get_overview") {
    const focus = data.focus as { title: string; due: string | null } | null;
    const late = (data.late as unknown[] | undefined)?.length ?? 0;
    const due = (data.dueThisWeek as unknown[] | undefined)?.length ?? 0;
    const lead = focus ? `Your focus is "${focus.title}"${focus.due ? `, due ${focus.due}` : ""}.` : "Nothing is open right now.";
    return `${lead} ${String(data.openTasks)} open, ${late} late, ${due} due this week.`;
  }
  if (result.name === "list_tasks") {
    const tasks = (JSON.parse(result.output) as { title: string; due: string | null }[]).slice(0, 6);
    if (tasks.length === 0) return "No tasks match.";
    return tasks.map((task) => `${task.title}${task.due ? ` (${task.due})` : ""}`).join("; ");
  }
  if (result.name === "get_money_summary") {
    const sales = data.sales as { count: number; revenue: string; costOfGoods: string };
    return `In ${String(data.month)}: ${sales.count} sale(s), revenue ${sales.revenue}, cost of goods ${sales.costOfGoods}. Other money in ${String(data.otherMoneyIn)}, out ${String(data.otherMoneyOut)}.`;
  }
  return "Done.";
}

export class StandInProvider implements ModelProvider {
  readonly id = "standin";
  readonly location = "local" as const;
  readonly model = "stand-in";
  private calls = 0;

  async available(): Promise<boolean> {
    return true;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const usage = { inputTokens: 0, outputTokens: 0 };
    const last = request.messages.at(-1);

    const answer = (text: string): ChatResponse => {
      request.onText?.(text);
      return { text, toolCalls: [], stop: "end", usage, model: this.model };
    };
    const use = (name: string, input: unknown): ChatResponse => ({
      text: "",
      toolCalls: [{ id: `standin-${++this.calls}`, name, input }],
      stop: "tool_use",
      usage,
      model: this.model,
    });

    // A tool just answered: say what it returned.
    if (last?.role === "tool") return answer(last.results.map(describe).join(" "));

    const text = lastUserText(request.messages).trim();
    const lower = text.toLowerCase();

    const add = /^(?:please\s+)?(?:add|create|new)\s+(?:a\s+)?task(?:\s+to|:)?\s+(.+)$/i.exec(text) ?? /^remind me to\s+(.+)$/i.exec(text);
    if (add?.[1]) return use("add_task", { title: add[1].replace(/[.!]+$/, ""), area: "inbox" });
    if (/\b(money|revenue|sales|profit|earned)\b/.test(lower)) return use("get_money_summary", { month: new Date().toISOString().slice(0, 7) });
    if (/\b(list|show|which)\b.*\btasks?\b/.test(lower)) return use("list_tasks", { show: /\blate\b/.test(lower) ? "late" : "open" });
    if (/\b(due|late|today|this week|focus|next|overview|status|should i do)\b/.test(lower)) return use("get_overview", {});
    return answer(HELP);
  }
}
