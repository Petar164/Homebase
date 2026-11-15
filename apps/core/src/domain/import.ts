import { INVOICE_PATTERN, parseDate, type Settings } from "@homebase/shared";
import { type Db, transaction } from "../db/open.ts";
import { AppError } from "../errors.ts";
import { newId, nowIso } from "../util.ts";
import { setSetting } from "./overview.ts";

// Brings data in from an export of the earlier Claude artifact version of
// Home Base, which stored its data as collections:
//
//   tasks, events, social      one document per item
//   ledger, training           one document per month, each { items: [...] }
//   settings                   a single document
//
// An export file holds real, private data. It must never be committed.
//
// The file is treated like any other outside input: every item is checked,
// and anything that does not fit is skipped and counted instead of trusted.

export type ImportSummary = {
  tasks: number;
  events: number;
  training: number;
  ledger: number;
  sales: number;
  stock: number;
  buyers: number;
  social: number;
  settings: boolean;
  skipped: number;
};

type Doc = Record<string, unknown>;

const HOME_BASE_TABLES = ["sales", "stock_items", "buyers", "ledger_entries", "tasks", "events", "training_sessions", "social_accounts"] as const;
const TASK_AREAS = ["inbox", "taxes", "business", "school", "coding", "career", "money", "health", "home", "social", "creative"] as const;
const LEDGER_AREAS = ["unsorted", "business", "personal", "school", "transfer"] as const;
const CURRENCIES = ["EUR", "USD", "GBP", "RSD", "CHF"] as const;

// ---------- reading values defensively ----------

function isDoc(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A collection can be a list of items or a map of id to item. */
function asList(value: unknown): Doc[] {
  if (Array.isArray(value)) return value.filter(isDoc);
  if (isDoc(value)) return Object.entries(value).filter(([, doc]) => isDoc(doc)).map(([id, doc]) => ({ id, ...(doc as Doc) }));
  return [];
}
/** Month documents ({ "2026-01": { items: [...] } }) flattened into one list. */
function monthItems(value: unknown): Doc[] {
  if (Array.isArray(value)) return value.filter(isDoc);
  return asList(value).flatMap((month) => (Array.isArray(month.items) ? month.items.filter(isDoc) : []));
}
function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000_000 ? value : null;
}
/** A real calendar day as YYYY-MM-DD, or "" (31 February is not a day). */
function day(value: unknown): string {
  const parsed = typeof value === "string" ? parseDate(value) : null;
  if (!parsed) return "";
  const date = new Date(`${parsed}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === parsed ? parsed : "";
}
function clock(value: unknown): string | null {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
function safeId(value: unknown): string {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value) ? value : newId();
}
function cents(amount: number): number {
  return Math.round(amount * 100);
}
function logPoints(value: unknown, max: number): { d: string; n: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isDoc)
    .map((point) => ({ d: day(point.d), n: num(point.n) }))
    .filter((point): point is { d: string; n: number } => !!point.d && point.n !== null)
    .slice(-max);
}

/** True when any Home Base table already holds rows. */
export function hasHomeBaseData(db: Db): boolean {
  return HOME_BASE_TABLES.some((table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined);
}

/**
 * Imports an export file. This REPLACES all Home Base records, so:
 *   - it refuses when records already exist, unless `replace` is set
 *   - the caller takes a snapshot first (the command line and the API do)
 * Login data, the audit log and history are never touched.
 */
export function importExport(db: Db, raw: unknown, options: { replace?: boolean } = {}): ImportSummary {
  if (!isDoc(raw)) throw new AppError(400, "The export file should contain one JSON object.");
  if (hasHomeBaseData(db) && !options.replace) {
    throw new AppError(409, "There are already records here. Importing replaces them all; confirm with the replace option.");
  }

  let skipped = 0;
  const now = nowIso();
  const summary: ImportSummary = { tasks: 0, events: 0, training: 0, ledger: 0, sales: 0, stock: 0, buyers: 0, social: 0, settings: false, skipped: 0 };

  // Either the whole import lands or nothing changes.
  transaction(db, () => {
    for (const table of HOME_BASE_TABLES) db.prepare(`DELETE FROM ${table}`).run();

    const insertTask = db.prepare(
      "INSERT OR IGNORE INTO tasks (id, title, area, due, done, done_at, note, repeat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const task of asList(raw.tasks)) {
      const title = str(task.title, 200);
      if (!title) {
        skipped++;
        continue;
      }
      const due = day(task.due) || null;
      const done = task.done === true;
      const created = typeof task.createdAt === "string" && !Number.isNaN(Date.parse(task.createdAt)) ? new Date(task.createdAt).toISOString() : now;
      const repeat = !due ? null : task.repeat === "w" ? "weekly" : task.repeat === "m" ? "monthly" : null;
      const result = insertTask.run(safeId(task.id), title, oneOf(task.area, TASK_AREAS, "inbox"), due, done ? 1 : 0, done ? day(task.doneAt) || null : null, str(task.note, 500) || null, repeat, created, now);
      summary.tasks += Number(result.changes);
    }

    const insertEvent = db.prepare(
      "INSERT INTO events (id, title, category, date, start_time, end_time, weekly, until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const event of asList(raw.events)) {
      const date = day(event.date);
      const title = str(event.title, 120);
      if (!date || !title) {
        skipped++;
        continue;
      }
      const weekly = event.repeat === "w";
      insertEvent.run(newId(), title, event.cat === "gym" || event.cat === "mma" ? event.cat : "activity", date, clock(event.s), clock(event.e), weekly ? 1 : 0, weekly ? day(event.until) || null : null, now, now);
      summary.events++;
    }

    const insertTraining = db.prepare("INSERT INTO training_sessions (id, date, time, kind, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const session of monthItems(raw.training)) {
      const date = day(session.date);
      if (!date) {
        skipped++;
        continue;
      }
      insertTraining.run(newId(), date, clock(session.time), oneOf(session.kind, ["gym", "mma"] as const, "gym"), now);
      summary.training++;
    }

    const buyerIds = new Set<string>();
    const insertBuyer = db.prepare(
      "INSERT OR IGNORE INTO buyers (id, name, email, street, postal_code, city, country, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const buyer of asList(raw.buyers)) {
      const name = str(buyer.name, 120);
      if (!name) {
        skipped++;
        continue;
      }
      const id = safeId(buyer.id);
      insertBuyer.run(id, name, str(buyer.email, 200), str(buyer.street, 160), str(buyer.postalCode, 20), str(buyer.city, 100), str(buyer.country, 60), now, now);
      buyerIds.add(id);
      summary.buyers++;
    }

    const freeStockIds = new Set<string>();
    const insertStock = db.prepare(
      "INSERT OR IGNORE INTO stock_items (id, description, purchase_price_cents, purchase_date, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const item of asList(raw.stock)) {
      const description = str(item.desc, 140);
      const cost = num(item.cost);
      const date = day(item.date);
      if (!description || cost === null || !date) {
        skipped++;
        continue;
      }
      const id = safeId(item.id);
      insertStock.run(id, description, cents(cost), date, str(item.source, 80), now, now);
      freeStockIds.add(id);
      summary.stock++;
    }

    // In the artifact a sale is a ledger item with area "business" and kind "in".
    const usedInvoices = new Set<string>();
    const usedKeys = new Set<string>();
    const insertSale = db.prepare(
      `INSERT INTO sales (id, date, description, price_cents, cost_cents, shipping_cents, other_costs_cents, region, method,
        invoice_number, status, buyer_id, stock_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLedger = db.prepare(
      `INSERT INTO ledger_entries (id, date, description, amount_cents, direction, area, category, vat_reclaimable, dedupe_key,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of monthItems(raw.ledger)) {
      const date = day(item.date);
      const amount = num(item.amount);
      const description = str(item.desc, 140);
      if (!date || amount === null || amount <= 0 || !description) {
        skipped++;
        continue;
      }
      if (item.area === "business" && item.kind === "in") {
        const cost = num(item.cost);
        let invoice = str(item.inv, 20).toUpperCase();
        if (!INVOICE_PATTERN.test(invoice) || usedInvoices.has(invoice)) invoice = "";
        if (invoice) usedInvoices.add(invoice);
        const stockItemId = typeof item.stockItemId === "string" && freeStockIds.delete(item.stockItemId) ? item.stockItemId : null;
        // Sales from before this app count as complete when they have what
        // the old version asked for: a purchase price and an invoice number.
        const status = item.status !== "draft" && invoice && cost !== null ? "complete" : "draft";
        const buyerId = typeof item.buyerId === "string" && buyerIds.has(item.buyerId) ? item.buyerId : null;
        insertSale.run(newId(), date, description, cents(amount), cost === null ? null : cents(cost), cents(num(item.ship) ?? 0), cents(num(item.other) ?? 0),
          oneOf(item.region, ["NL", "EU", "world"] as const, "NL"), str(item.method, 40) || "Other", invoice || null, status, buyerId, stockItemId, now, now);
        summary.sales++;
        continue;
      }
      let key = str(item.k, 300) || null;
      if (key && usedKeys.has(key)) key = null;
      if (key) usedKeys.add(key);
      insertLedger.run(newId(), date, description, cents(amount), oneOf(item.kind, ["in", "out"] as const, "out"), oneOf(item.area, LEDGER_AREAS, "unsorted"),
        str(item.cat, 60) || null, item.vat === true ? 1 : 0, key, now, now);
      summary.ledger++;
    }

    const insertSocial = db.prepare("INSERT INTO social_accounts (id, name, platform, status, goal, log, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const account of asList(raw.social)) {
      const name = str(account.name, 80);
      if (!name) {
        skipped++;
        continue;
      }
      insertSocial.run(newId(), name, str(account.platform, 40), oneOf(account.status, ["active", "banned"] as const, "active"), Math.round(num(account.goal) ?? 0),
        JSON.stringify(logPoints(account.log, 1000)), now, now);
      summary.social++;
    }

    // settings may be the document itself or { main: document }
    const doc = isDoc(raw.settings) ? (isDoc(raw.settings.main) ? raw.settings.main : raw.settings) : null;
    if (doc) {
      const savings = isDoc(doc.savings) ? doc.savings : {};
      const webshop = isDoc(doc.webshop) ? doc.webshop : {};
      const settings: Omit<Settings, "demo"> = {
        currency: oneOf(doc.currency, CURRENCIES, "EUR"),
        vatRate: Math.min(100, num(doc.vatRate) ?? 21),
        classes: asList(doc.classes)
          .map((slot) => ({ d: Number(slot.d), s: clock(slot.s) ?? "", e: clock(slot.e) ?? "", name: str(slot.name, 80), room: str(slot.room, 80) }))
          .filter((slot) => slot.d >= 1 && slot.d <= 7 && slot.s && slot.e && slot.name),
        classesEnd: day(doc.classesEnd),
        mmaSlots: asList(doc.mmaSlots)
          .map((slot) => ({ d: Number(slot.d), t: clock(slot.t) ?? "" }))
          .filter((slot) => slot.d >= 1 && slot.d <= 7 && slot.t),
        savings: { have: num(savings.have) ?? 0, goal: num(savings.goal) ?? 0, log: logPoints(savings.log, 120) },
        webshop: { orders: Math.round(num(webshop.orders) ?? 0), revenue: num(webshop.revenue) ?? 0, shipped: Math.round(num(webshop.shipped) ?? 0), asOf: day(webshop.asOf) },
      };
      for (const [key, value] of Object.entries(settings)) setSetting(db, key as keyof Settings, value as never);
      summary.settings = true;
    }
    setSetting(db, "demo", false);
  });

  summary.skipped = skipped;
  return summary;
}
