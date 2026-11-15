import { addDays, AREA_NAME, taskCreateSchema, ymd } from "@homebase/shared";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { buildOverview } from "../domain/overview.ts";
import { createTask, listTasks, updateTask } from "../domain/tasks.ts";
import type { Sensitivity, ToolSpec } from "./types.ts";

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

export type Tool<Input = unknown> = {
  name: string;
  description: string;
  tier: 0 | 1 | 2 | 3;
  /** The label of whatever this tool returns. */
  sensitivity: Sensitivity;
  input: z.ZodType<Input>;
  /** One line shown to the owner when a yes is needed. */
  describe(input: Input): string;
  run(input: Input, context: { db: Db; now: Date }): string;
};

function define<Input>(tool: Tool<Input>): Tool {
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
    name: "add_task",
    description: "Adds a task to the owner's list. The owner is asked to confirm before it is saved.",
    tier: 1,
    sensitivity: "private",
    input: taskCreateSchema,
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
