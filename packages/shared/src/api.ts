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

// ---------- HELIOS ----------

/** What HELIOS is doing right now. The screen and the brain follow this. */
export const HELIOS_STATES = ["idle", "listening", "transcribing", "thinking", "retrieving", "speaking", "acting", "presenting", "error"] as const;
export type HeliosState = (typeof HELIOS_STATES)[number];

export type ConversationSummary = { id: string; title: string; channel: "text" | "voice"; startedAt: string; lastMessageAt: string };

/** One line of a transcript, as the screen shows it. Tool traffic is left out. */
export type ConversationMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  /** Which model answered, for assistant messages. */
  model: string | null;
  /** Why the router chose that model. */
  route: string | null;
};

/** A yes HELIOS is waiting for. */
export type Approval = {
  id: string;
  kind: "tool" | "cloud_egress";
  /** 3 means the password has to be confirmed first. */
  tier: number;
  summary: string;
  /** For cloud approvals: what would be sent, message by message. */
  preview: { role: string; sensitivity: string; excerpt: string }[];
  conversationId: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  expiresAt: string;
};

export type HeliosStatus = {
  state: HeliosState;
  /** The models HELIOS could use. `role` is what each one is for. */
  models: { id: string; role: "local" | "strong" | "light" | "standin"; model: string; location: "local" | "cloud"; available: boolean }[];
  /** Cloud spending this calendar month, in euros, counted on the safe side. */
  budget: { spentEur: number; warnEur: number; capEur: number; state: "ok" | "warning" | "capped" };
  /** False when the owner switched cloud models off. */
  cloudEnabled: boolean;
};

export type TurnResult = {
  conversationId: string;
  /** Everything added to the transcript by this turn, in order. */
  messages: ConversationMessage[];
  approvals: Approval[];
};

/** What the core pushes to the screen over the event stream. */
export type CoreEvent =
  | { type: "state"; state: HeliosState }
  | { type: "message"; conversationId: string; message: ConversationMessage }
  | { type: "delta"; conversationId: string; text: string }
  | { type: "approval"; approval: Approval };
