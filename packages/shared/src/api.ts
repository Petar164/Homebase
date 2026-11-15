// The shapes the core's API returns for the first screens.

import type { CalEvent, ClassSlot, Task, TrainingSession } from "./types.ts";

export type SessionInfo = {
  authenticated: boolean;
  /** False until the owner account has been created from the command line. */
  ownerExists: boolean;
  /** True for a few minutes after re-entering the password. */
  elevated: boolean;
  username: string | null;
};

export type DayOverview = {
  date: string;
  classes: ClassSlot[];
  events: CalEvent[];
  training: TrainingSession[];
  tasksDue: number;
};

/** Everything the main screen shows, in one request. */
export type Overview = {
  today: string;
  /** The one task to look at first: the most overdue, else the next due. */
  focus: Task | null;
  late: Task[];
  dueThisWeek: Task[];
  later: Task[];
  openCount: number;
  doneThisWeek: number;
  /** Monday to Sunday of the current week. */
  week: DayOverview[];
  savings: { have: number; goal: number };
  currency: string;
};

export type SystemStatus = {
  version: string;
  schemaVersion: number;
  startedAt: string;
  snapshots: { count: number; newestAt: string | null; newestKind: string | null };
  mirrors: { path: string; connected: boolean; newestAt: string | null }[];
  audit: { ok: boolean; entries: number };
};

export type SnapshotSummary = { id: string; createdAt: string; kind: string; note: string; schemaVersion: number; files: number; bytes: number };
