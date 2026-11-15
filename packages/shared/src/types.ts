// The shapes the browser works with. The server converts database rows into
// these (see src/lib/server/data.ts) so the browser never sees more than it needs.
// Amounts here are in whole currency units (12.5 = EUR 12.50); the database
// stores cents.

export const TASK_AREAS = [
  ["taxes", "Taxes"],
  ["business", "Business"],
  ["school", "School"],
  ["coding", "Coding"],
  ["career", "Career and the move"],
  ["money", "Personal money"],
  ["health", "Health and sleep"],
  ["home", "Home and bills"],
  ["social", "Social and events"],
  ["creative", "Creative projects"],
] as const;

export type TaskArea = (typeof TASK_AREAS)[number][0] | "inbox";

export const AREA_NAME: Record<string, string> = Object.fromEntries(TASK_AREAS);

export const LEDGER_AREAS = [
  ["unsorted", "To sort"],
  ["business", "Business"],
  ["personal", "Personal"],
  ["school", "School"],
  ["transfer", "Transfer (not counted)"],
] as const;

export type LedgerArea = (typeof LEDGER_AREAS)[number][0];

export const PAYMENT_METHODS = ["Website", "Stripe", "PayPal", "Bank transfer", "Vinted", "Other"];

export const EXPENSE_CATEGORIES = [
  "Shipping and packaging",
  "Website and software",
  "Marketing",
  "Payment fees",
  "Equipment",
  "Travel",
  "Other",
];

export const CURRENCIES = ["EUR", "USD", "GBP", "RSD", "CHF"];

export type Task = {
  id: string;
  title: string;
  area: TaskArea;
  due: string; // "" when there is no deadline
  done: boolean;
  doneAt: string;
  note: string;
  repeat: "" | "w" | "m";
  createdAt: string;
};

export type CalEvent = {
  id: string;
  title: string;
  cat: "" | "gym" | "mma";
  date: string;
  s: string; // start "HH:MM" or ""
  e: string; // end "HH:MM" or ""
  repeat: "" | "w";
  until: string;
};

export type TrainingSession = {
  id: string;
  date: string;
  time: string;
  kind: "gym" | "mma";
};

export type LedgerEntry = {
  id: string;
  date: string;
  desc: string;
  amount: number;
  kind: "in" | "out";
  area: LedgerArea;
  cat: string;
  vat: boolean;
};

export type SaleRegion = "NL" | "EU" | "world";

export type Sale = {
  id: string;
  date: string;
  desc: string;
  amount: number;
  cost: number | null;
  ship: number;
  other: number;
  region: SaleRegion;
  method: string;
  inv: string;
  status: "draft" | "complete";
  buyerId: string;
  stockItemId: string;
};

export type StockItem = {
  id: string;
  desc: string;
  cost: number;
  date: string;
  source: string;
  saleId: string; // "" while it is still in stock
};

export type Buyer = {
  id: string;
  name: string;
  email: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
};

export type LogPoint = { d: string; n: number };

export type SocialAccount = {
  id: string;
  name: string;
  platform: string;
  status: "active" | "banned";
  goal: number;
  log: LogPoint[];
};

export type ClassSlot = { d: number; s: string; e: string; name: string; room: string };
export type MmaSlot = { d: number; t: string };

export type Settings = {
  currency: string;
  vatRate: number; // percent, 21 means 21%
  classes: ClassSlot[];
  classesEnd: string;
  mmaSlots: MmaSlot[];
  savings: { have: number; goal: number; log: LogPoint[] };
  webshop: { orders: number; revenue: number; shipped: number; asOf: string };
  demo: boolean;
};

export type DashboardData = {
  tasks: Task[];
  events: CalEvent[];
  training: TrainingSession[];
  ledger: LedgerEntry[];
  sales: Sale[];
  stock: StockItem[];
  buyers: Buyer[];
  social: SocialAccount[];
  settings: Settings;
};
