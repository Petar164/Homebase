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
/** "retrieving" is searching its own memory; "browsing" is searching or reading the public web. */
export const HELIOS_STATES = ["idle", "listening", "transcribing", "thinking", "retrieving", "browsing", "speaking", "acting", "presenting", "error"] as const;
export type HeliosState = (typeof HELIOS_STATES)[number];

export type ConversationSummary = { id: string; title: string; channel: "text" | "voice"; startedAt: string; lastMessageAt: string };

/**
 * A page HELIOS got from the live web. Its number is what an answer cites
 * as [n]; it stays the same for the whole conversation. Sources only ever
 * come from what a web tool really returned, never from a model's words.
 */
export type WebSource = {
  n: number;
  title: string;
  url: string;
  /** The site's host name, for example "example.org". */
  site: string;
  /** "page": HELIOS opened and read it. "result": it appeared in search results. */
  kind: "result" | "page";
  /** The date the page or the search service gave, as YYYY-MM-DD. Null when neither gave one. */
  date: string | null;
};

/** How the live web was used for one answer. Absent on an answer that did not use it. */
export type WebUse = {
  /** True when at least one search or one page really came back for this answer. */
  live: boolean;
  /** Searches that were sent, and pages that were read. */
  searches: number;
  pages: number;
  /** What did not work, in plain words. Empty when everything did. */
  failures: string[];
  /** The pages that were opened and the results the answer cites, in the order of their numbers. */
  sources: WebSource[];
};

/** A web request while it is happening, for the line of feedback on screen. */
export type WebActivity = {
  id: string;
  kind: "search" | "page";
  /** What is being done, for example: Searching the web for "..." */
  label: string;
  /** "waiting" means the owner has been asked and nothing was sent. */
  status: "running" | "done" | "failed" | "waiting";
  /** Why it failed, or how much came back. */
  detail: string | null;
};

/** Whether HELIOS may use the web right now. */
export type WebStatus = {
  /** The owner's switch. */
  enabled: boolean;
  /** True when a search could run right now. */
  ready: boolean;
  /** The search service in use, by name. */
  service: string | null;
  /** True when every web request needs a yes, not only the ones that may carry private details. */
  confirmEvery: boolean;
  /** Why it is not ready, in plain words. */
  problem: string | null;
};

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
  /** Set on an answer for which the live web was searched or read. */
  web?: WebUse | null;
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
  /** For web requests: exactly what would be sent, to whom, and why the owner is asked. */
  web?: { kind: "search" | "page"; sends: string; to: string; because: string } | null;
  conversationId: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: string;
  expiresAt: string;
};

/** Whether HELIOS may send a conversation to a cloud model, and whether it could right now. */
export type CloudStatus = {
  /** The owner's switch. Off until the owner turns it on. */
  enabled: boolean;
  /** True when a cloud model could be asked right now: switched on, a key present, room in the budget. */
  ready: boolean;
  /** Who a conversation would be sent to, by name. */
  service: string | null;
  /** The cloud models that are set up, the stronger one first. */
  models: string[];
  /** Why it is not ready, in plain words. */
  problem: string | null;
};

export type HeliosStatus = {
  state: HeliosState;
  /** The models HELIOS could use. `role` is what each one is for. */
  models: { id: string; role: "local" | "strong" | "light" | "standin"; model: string; location: "local" | "cloud"; available: boolean }[];
  /** Cloud spending this calendar month, in euros, counted on the safe side. */
  budget: { spentEur: number; warnEur: number; capEur: number; state: "ok" | "warning" | "capped" };
  /** False while cloud models are switched off. The same as `cloud.enabled`. */
  cloudEnabled: boolean;
  cloud: CloudStatus;
  web: WebStatus;
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
  | { type: "approval"; approval: Approval }
  | { type: "activity"; conversationId: string; activity: WebActivity };
