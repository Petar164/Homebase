import { addDays, AREA_NAME, taskCreateSchema, ymd } from "@homebase/shared";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/open.ts";
import { buildOverview } from "../domain/overview.ts";
import { createTask, listTasks, updateTask } from "../domain/tasks.ts";
import type { WebAccess } from "../web/service.ts";
import type { SourceBook } from "../web/sources.ts";
import { hitsSensitivity, searchConversations } from "./memory.ts";
import { budgetStatus } from "./policy.ts";
import type { Sensitivity, ToolResult, ToolSpec } from "./types.ts";
import { WEB_TOOLS } from "./webTools.ts";

// What HELIOS can do. A model never touches the database: it can only ask
// for one of these tools, by name, with input that is checked against the
// tool's schema before anything runs.
//
// Every tool has a risk tier (docs/SECURITY.md):
//   0  read-only, inside Home Base             runs at once
//   1  small reversible change in Home Base    needs a yes
//   2  change outside Home Base                needs on-screen confirmation
//   3  sensitive or destructive                needs step-up authentication
//
// Every tool also labels its output, so the core knows how private the
// conversation has become and whether it may still go to a cloud model.
//
// The two web tools (webTools.ts) are the only ones that reach outside this
// machine. Their tier is 0 for a request that carries nothing private, and
// is raised per request by `check` when it might (web/policy.ts).

/** What a turn has done so far. Rules that depend on it read it from here, never from a model. */
export type TurnFacts = {
  /** What the owner said to start this turn. */
  ownerText: string;
  /** Everything the owner said in this conversation, for the web addresses they gave themselves. */
  ownerTexts: string[];
  /** True once text from the web was read in this turn. From then on nothing is changed on a standing permission. */
  webRead: boolean;
  /** True once a Home Base record was read in this turn. */
  recordsRead: boolean;
  /** The text of Home Base records this conversation has read. */
  records: string[];
  /** Web requests sent in this turn. */
  searches: number;
  pages: number;
  /** The numbered web pages this conversation has seen. */
  sources: SourceBook;
  /** How many characters of new text the model's context still has room for. */
  roomChars: number;
};

export type ToolContext = {
  db: Db;
  config: Config;
  now: Date;
  conversationId: string;
  /** HELIOS's access to the web. Absent in a core that was started without it. */
  web?: WebAccess;
  turn: TurnFacts;
  /** True when the owner has just approved exactly this request on screen. */
  approved?: boolean;
};

/** What a tool hands back besides the text for the model. */
export type ToolOutput = string | ({ output: string; sensitivity: Sensitivity; failed?: boolean } & Pick<ToolResult, "brief" | "sources" | "web">);

/** A closer look at one request: it may need a yes although the tool normally runs at once, or be refused outright. */
export type ToolCheck = {
  /** Raises the tier for this one request. */
  tier?: 1 | 2 | 3;
  /** Shown to the owner with the request for a yes: what would be sent, to whom, and why they are asked. */
  web?: { kind: "search" | "page"; sends: string; to: string; because: string };
  /** The request is not carried out. `say` is for the model, `failure` for the owner. */
  refuse?: { say: string; failure: string; kind: string; web?: ToolResult["web"] };
};

export type Tool<Input = unknown> = {
  name: string;
  description: string;
  tier: 0 | 1 | 2 | 3;
  /** The label of whatever this tool returns. */
  sensitivity: Sensitivity;
  /** Set for tools that search memory, so the screen can show "searching". */
  searches?: boolean;
  /** "web": the tool reaches the public internet and returns text that nobody here wrote. */
  reach?: "web";
  input: z.ZodType<Input>;
  /** One line shown to the owner when a yes is needed. */
  describe(input: Input, context?: ToolContext): string;
  /** Looks at one request before it runs. Without it, the tier alone decides. */
  check?(input: Input, context: ToolContext): ToolCheck;
  /** For web tools: what the screen says while the request is under way. Only what the owner may see anyway. */
  activity?(input: Input, context: ToolContext): { kind: "search" | "page"; label: string };
  /** Returns the output, or the output with its own label when that depends on what was found. */
  run(input: Input, context: ToolContext): ToolOutput | Promise<ToolOutput>;
};

export function define<Input>(tool: Tool<Input>): Tool {
  return tool as unknown as Tool;
}

const taskFilter = z.object({
  show: z.enum(["open", "late", "due_this_week", "done_this_week"]).default("open").describe("Which tasks to list"),
  area: z.string().max(40).optional().describe("Only this area, for example school, business, coding"),
});

const money = (cents: number) => (cents / 100).toFixed(2);

export const TOOLS: Tool[] = [
  define({
    name: "get_overview",
    description:
      "The owner's planning picture for today: the task to focus on, how many tasks are open, late and due this week, " +
      "and what is on the calendar each day of the current week. Call this first for any question about today, this week or what to do next.",
    tier: 0,
    sensitivity: "private",
    input: z.object({}),
    describe: () => "Read today's overview",
    run(_input, { db, now }) {
      const overview = buildOverview(db, now);
      const task = (t: { title: string; area: string; due: string }) => ({ title: t.title, area: AREA_NAME[t.area] ?? "Inbox", due: t.due || null });
      return JSON.stringify({
        today: overview.today,
        focus: overview.focus && task(overview.focus),
        openTasks: overview.openCount,
        doneThisWeek: overview.doneThisWeek,
        late: overview.late.map(task),
        dueThisWeek: overview.dueThisWeek.map(task),
        week: overview.week.map((day) => ({
          date: day.date,
          classes: day.classes.map((slot) => `${slot.s} ${slot.name}`),
          events: day.events.map((event) => `${event.s} ${event.title}`.trim()),
          tasksDue: day.tasksDue,
        })),
      });
    },
  }),

  define({
    name: "list_tasks",
    description: "Lists the owner's tasks with their id, title, area and deadline. Use the id from this list when completing a task.",
    tier: 0,
    sensitivity: "private",
    input: taskFilter,
    describe: (input) => `List ${input.show.replaceAll("_", " ")} tasks`,
    run(input, { db, now }) {
      const today = ymd(now);
      const overview = buildOverview(db, now);
      const monday = overview.week[0]?.date ?? today;
      let tasks = listTasks(db);
      if (input.show === "open") tasks = tasks.filter((task) => !task.done);
      if (input.show === "late") tasks = tasks.filter((task) => !task.done && task.due && task.due < today);
      if (input.show === "due_this_week") tasks = tasks.filter((task) => !task.done && task.due >= today && task.due <= addDays(monday, 6));
      if (input.show === "done_this_week") tasks = tasks.filter((task) => task.done && task.doneAt >= monday);
      if (input.area) tasks = tasks.filter((task) => task.area === input.area);
      return JSON.stringify(tasks.slice(0, 60).map((task) => ({ id: task.id, title: task.title, area: task.area, due: task.due || null, done: task.done })));
    },
  }),

  define({
    name: "get_money_summary",
    description: "Totals for one month of the owner's business: number of sales, revenue, cost of goods, and other money in and out. Month as YYYY-MM.",
    tier: 0,
    // Finances are sensitive: once this is in a conversation, the
    // conversation needs approval before it can go to a cloud model.
    sensitivity: "sensitive",
    input: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).describe("The month, as YYYY-MM") }),
    describe: (input) => `Read the money summary for ${input.month}`,
    run(input, { db }) {
      const sales = db
        .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(price_cents), 0) AS revenue, COALESCE(SUM(cost_cents), 0) AS cost FROM sales WHERE deleted_at IS NULL AND substr(date, 1, 7) = ?")
        .get(input.month) as { count: number; revenue: number; cost: number };
      const ledger = db
        .prepare("SELECT direction, COALESCE(SUM(amount_cents), 0) AS total FROM ledger_entries WHERE deleted_at IS NULL AND area != 'transfer' AND substr(date, 1, 7) = ? GROUP BY direction")
        .all(input.month) as { direction: "in" | "out"; total: number }[];
      const total = (direction: "in" | "out") => ledger.find((row) => row.direction === direction)?.total ?? 0;
      return JSON.stringify({
        month: input.month,
        sales: { count: sales.count, revenue: money(sales.revenue), costOfGoods: money(sales.cost) },
        otherMoneyIn: money(total("in")),
        otherMoneyOut: money(total("out")),
      });
    },
  }),

  define({
    name: "search_conversations",
    description:
      "Searches everything the owner and HELIOS said in earlier conversations and returns the best matching passages with their dates. " +
      "Use it when the owner asks what was said, decided or planned before. Search with a few key words, not a full sentence.",
    tier: 0,
    sensitivity: "private",
    searches: true,
    input: z.object({ query: z.string().trim().min(2).max(200).describe("Key words to look for") }),
    describe: (input) => `Search earlier conversations for "${input.query}"`,
    run(input, { db, conversationId }) {
      const hits = searchConversations(db, input.query, { excludeConversationId: conversationId });
      const output = JSON.stringify(hits.map((hit) => ({ when: hit.at.slice(0, 10), conversation: hit.conversationTitle, saidBy: hit.role === "user" ? "owner" : "HELIOS", passage: hit.snippet })));
      return { output, sensitivity: hitsSensitivity(hits) };
    },
  }),

  define({
    name: "get_answer_info",
    description:
      "Which model wrote HELIOS's recent answers in this conversation and why it was chosen, plus this month's cloud spending against its limit. " +
      "Use it when the owner asks which model answered, why, or what the cloud has cost.",
    tier: 0,
    sensitivity: "normal",
    input: z.object({}),
    describe: () => "Look up which model answered",
    run(_input, { db, config, now, conversationId }) {
      const answers = db
        .prepare("SELECT model, provider, route_reason, created_at FROM messages WHERE conversation_id = ? AND role = 'assistant' AND text != '' ORDER BY seq DESC LIMIT 3")
        .all(conversationId) as { model: string | null; provider: string | null; route_reason: string | null; created_at: string }[];
      const budget = budgetStatus(db, config, now);
      return JSON.stringify({
        recentAnswers: answers.map((answer) => ({ model: answer.model, ranOn: answer.provider?.startsWith("claude") ? "the cloud" : "this machine", chosenBecause: answer.route_reason, at: answer.created_at })),
        cloudThisMonth: { spentEur: Number((budget.spentEur + budget.reservedEur).toFixed(4)), warnAtEur: budget.warnEur, limitEur: budget.capEur, state: budget.state },
      });
    },
  }),

  define({
    name: "add_task",
    description: "Adds a task to the owner's list. The owner is asked to confirm before it is saved.",
    tier: 1,
    sensitivity: "private",
    // The same rules as the screen's form, with the date format spelled out:
    // a small local model otherwise writes "tomorrow" where a date belongs.
    input: taskCreateSchema.extend({
      due: taskCreateSchema.shape.due.describe('The deadline as a calendar date, YYYY-MM-DD, worked out from today\'s date. Use "" for no deadline. Never a word such as "tomorrow".'),
      area: taskCreateSchema.shape.area.describe('Which part of life this belongs to. Use "inbox" when unsure.'),
      repeat: taskCreateSchema.shape.repeat.describe('"w" for weekly, "m" for monthly, "" for once.'),
    }),
    describe: (input) => `Add the task "${input.title}"${input.due ? `, due ${input.due}` : ""}`,
    run(input, { db }) {
      const task = createTask(db, input);
      return JSON.stringify({ added: { id: task.id, title: task.title, due: task.due || null } });
    },
  }),

  define({
    name: "complete_task",
    description: "Marks one task as done. Takes the task id from list_tasks. The owner is asked to confirm first.",
    tier: 1,
    sensitivity: "private",
    input: z.object({ id: z.string().regex(/^[\w-]{1,64}$/).describe("The task id from list_tasks") }),
    describe: (input) => `Mark task ${input.id} as done`,
    run(input, { db, now }) {
      const { task, next } = updateTask(db, input.id, { done: true, doneAt: ymd(now) }, "helios");
      return JSON.stringify({ completed: task.title, nextOccurrence: next?.due ?? null });
    },
  }),

  ...WEB_TOOLS,
];

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** The tool list in the form models are given: name, purpose, input shape. */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((tool) => {
    const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
    return { name: tool.name, description: tool.description, inputSchema };
  });
}
