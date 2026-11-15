import { addDays, type Task, type TaskArea, type taskCreateSchema, type taskUpdateSchema, ymd } from "@homebase/shared";
import type { z } from "zod";
import { type Db, transaction } from "../db/open.ts";
import { AppError } from "../errors.ts";
import { newId, nowIso } from "../util.ts";

// Tasks. This file is the pattern for every Home Base record:
//   - rows are converted to the shape the screen uses in one place (toTask)
//   - every edit first saves the previous version to record_revisions
//   - deleting marks the row (deleted_at); it does not remove it

type TaskRow = {
  id: string;
  title: string;
  area: string;
  due: string | null;
  done: number;
  done_at: string | null;
  note: string | null;
  repeat: "weekly" | "monthly" | null;
  created_at: string;
};

const COLUMNS = "id, title, area, due, done, done_at, note, repeat, created_at";
const REPEAT_OUT = { weekly: "w", monthly: "m" } as const;
const REPEAT_IN = { "": null, w: "weekly", m: "monthly" } as const;

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    area: row.area as TaskArea,
    due: row.due ?? "",
    done: row.done === 1,
    doneAt: row.done_at ?? "",
    note: row.note ?? "",
    repeat: row.repeat ? REPEAT_OUT[row.repeat] : "",
    createdAt: row.created_at,
  };
}

/** Keeps the previous version of a row, so one wrong edit can be undone. */
export function saveRevision(db: Db, table: string, rowId: string, change: "update" | "delete", before: unknown, actor: string): void {
  db.prepare("INSERT INTO record_revisions (table_name, row_id, change, data, actor, changed_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    table,
    rowId,
    change,
    JSON.stringify(before),
    actor,
    nowIso(),
  );
}

function findRow(db: Db, id: string): TaskRow {
  const row = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ? AND deleted_at IS NULL`).get(id) as TaskRow | undefined;
  if (!row) throw new AppError(404, "That task no longer exists.");
  return row;
}

/** Open tasks first (soonest deadline first, undated last), then finished ones. */
export function listTasks(db: Db): Task[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM tasks WHERE deleted_at IS NULL ORDER BY done, due IS NULL, due, created_at`)
    .all() as TaskRow[];
  return rows.map(toTask);
}

function insertTask(db: Db, values: { title: string; area: string; due: string | null; repeat: TaskRow["repeat"]; note: string | null }): Task {
  const id = newId();
  const now = nowIso();
  db.prepare("INSERT INTO tasks (id, title, area, due, repeat, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    values.title,
    values.area,
    values.due,
    values.repeat,
    values.note,
    now,
    now,
  );
  return toTask(findRow(db, id));
}

export function createTask(db: Db, input: z.infer<typeof taskCreateSchema>): Task {
  return insertTask(db, {
    title: input.title,
    area: input.area,
    due: input.due || null,
    // A task can only repeat when it has a date to repeat from.
    repeat: input.due ? REPEAT_IN[input.repeat] : null,
    note: input.note || null,
  });
}

/** The same day next month, or the last day of that month if it is shorter. */
function nextMonth(day: string): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const lastDay = new Date(year, month + 1, 0).getDate();
  return ymd(new Date(year, month, Math.min(date, lastDay)));
}

export function updateTask(db: Db, id: string, input: z.infer<typeof taskUpdateSchema>, actor: string): { task: Task; next: Task | null } {
  return transaction(db, () => {
    const before = findRow(db, id);
    saveRevision(db, "tasks", id, "update", before, actor);

    const due = input.due === undefined ? before.due : input.due || null;
    const repeat = !due ? null : input.repeat === undefined ? before.repeat : REPEAT_IN[input.repeat];
    const done = input.done === undefined ? before.done === 1 : input.done;
    const doneAt = !done ? null : input.done === undefined ? before.done_at : input.doneAt || ymd(new Date());

    db.prepare("UPDATE tasks SET title = ?, area = ?, due = ?, repeat = ?, note = ?, done = ?, done_at = ?, updated_at = ? WHERE id = ?").run(
      input.title ?? before.title,
      input.area ?? before.area,
      due,
      repeat,
      input.note === undefined ? before.note : input.note || null,
      done ? 1 : 0,
      doneAt,
      nowIso(),
      id,
    );
    const task = toTask(findRow(db, id));

    // Ticking off a repeating task creates the next one, a week or a month later.
    let next: Task | null = null;
    if (done && before.done === 0 && repeat && due) {
      next = insertTask(db, {
        title: task.title,
        area: task.area,
        due: repeat === "weekly" ? addDays(due, 7) : nextMonth(due),
        repeat,
        note: task.note || null,
      });
    }
    return { task, next };
  });
}

export function deleteTask(db: Db, id: string, actor: string): void {
  transaction(db, () => {
    const before = findRow(db, id);
    saveRevision(db, "tasks", id, "delete", before, actor);
    db.prepare("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
  });
}
