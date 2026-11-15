import {
  addDays,
  type CalEvent,
  type ClassSlot,
  type DayOverview,
  mondayOf,
  type Overview,
  type Settings,
  type TrainingSession,
  weekday,
  ymd,
} from "@homebase/shared";
import type { Db } from "../db/open.ts";
import { listTasks } from "./tasks.ts";

// ---------- settings ----------
// One row per setting, value stored as JSON. Reading always goes through
// defaults, so a setting that was never saved still has a sensible value.

const DEFAULT_SETTINGS: Settings = {
  currency: "EUR",
  vatRate: 21,
  classes: [],
  classesEnd: "",
  mmaSlots: [],
  savings: { have: 0, goal: 0, log: [] },
  webshop: { orders: 0, revenue: 0, shipped: 0, asOf: "" },
  demo: false,
};

export function getSettings(db: Db): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const saved = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  return { ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>) };
}

export function setSetting<K extends keyof Settings>(db: Db, key: K, value: Settings[K]): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

// ---------- calendar rows ----------

type EventRow = { id: string; title: string; category: "activity" | "gym" | "mma"; date: string; start_time: string | null; end_time: string | null; weekly: number; until: string | null };

export function listEvents(db: Db): CalEvent[] {
  const rows = db
    .prepare("SELECT id, title, category, date, start_time, end_time, weekly, until FROM events WHERE deleted_at IS NULL ORDER BY date, start_time")
    .all() as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    cat: row.category === "activity" ? "" : row.category,
    date: row.date,
    s: row.start_time ?? "",
    e: row.end_time ?? "",
    repeat: row.weekly === 1 ? "w" : "",
    until: row.until ?? "",
  }));
}

export function listTraining(db: Db, from: string, to: string): TrainingSession[] {
  const rows = db
    .prepare("SELECT id, date, time, kind FROM training_sessions WHERE deleted_at IS NULL AND date BETWEEN ? AND ? ORDER BY date, time")
    .all(from, to) as { id: string; date: string; time: string | null; kind: "gym" | "mma" }[];
  return rows.map((row) => ({ id: row.id, date: row.date, time: row.time ?? "", kind: row.kind }));
}

/** True when an event happens on `day`, counting weekly repeats. */
function happensOn(event: CalEvent, day: string): boolean {
  if (event.date === day) return true;
  if (event.repeat !== "w" || event.date > day) return false;
  return weekday(event.date) === weekday(day) && (!event.until || day <= event.until);
}

// ---------- the main screen ----------

/** Everything the main screen needs, for the given calendar day. */
export function buildOverview(db: Db, now: Date = new Date()): Overview {
  const today = ymd(now);
  const monday = ymd(mondayOf(now));
  const sunday = addDays(monday, 6);

  const tasks = listTasks(db);
  const open = tasks.filter((task) => !task.done);
  const late = open.filter((task) => task.due && task.due < today);
  const dueThisWeek = open.filter((task) => task.due && task.due >= today && task.due <= sunday);
  const later = open.filter((task) => !task.due || task.due > sunday);

  const settings = getSettings(db);
  const events = listEvents(db);
  const training = listTraining(db, monday, sunday);
  const week: DayOverview[] = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(monday, index);
    const classes: ClassSlot[] = settings.classes
      .filter((slot) => slot.d === weekday(date) && (!settings.classesEnd || date <= settings.classesEnd))
      .sort((a, b) => a.s.localeCompare(b.s));
    return {
      date,
      classes,
      events: events.filter((event) => happensOn(event, date)),
      training: training.filter((session) => session.date === date),
      tasksDue: open.filter((task) => task.due === date).length,
    };
  });

  return {
    today,
    focus: late[0] ?? dueThisWeek[0] ?? later[0] ?? null,
    late,
    dueThisWeek,
    later: later.slice(0, 20),
    openCount: open.length,
    doneThisWeek: tasks.filter((task) => task.done && task.doneAt >= monday).length,
    week,
    savings: { have: settings.savings.have, goal: settings.savings.goal },
    currency: settings.currency,
  };
}
