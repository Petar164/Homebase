import { type Buyer, missingInvoiceFields, nextInvoiceNumber, type Sale, type SaleInput, type StockItem, type stockSchema } from "@homebase/shared";
import type { z } from "zod";
import { type Db, transaction } from "../db/open.ts";
import { AppError } from "../errors.ts";
import { newId, nowIso } from "../util.ts";
import { saveRevision } from "./tasks.ts";

// Sales, the stock they come from, and the buyers. All the rules live here,
// in the core:
//   - an invoice number is used once, ever (also after a sale is deleted)
//   - a stock item can be sold once
//   - a sale is only "complete" when every invoice field is filled in
// The screen checks the same things to be helpful, but a screen can be
// bypassed. This code cannot.

type SaleRow = {
  id: string;
  date: string;
  description: string;
  price_cents: number;
  cost_cents: number | null;
  shipping_cents: number;
  other_costs_cents: number;
  region: Sale["region"];
  method: string;
  invoice_number: string | null;
  status: Sale["status"];
  buyer_id: string | null;
  stock_item_id: string | null;
};
type StockRow = { id: string; description: string; purchase_price_cents: number; purchase_date: string; source: string; sale_id: string | null };
type BuyerRow = { id: string; name: string; email: string; street: string; postal_code: string; city: string; country: string };

const SALE_COLUMNS = "id, date, description, price_cents, cost_cents, shipping_cents, other_costs_cents, region, method, invoice_number, status, buyer_id, stock_item_id";
const cents = (amount: number) => Math.round(amount * 100);
const units = (amount: number) => amount / 100;

function toSale(row: SaleRow): Sale {
  return {
    id: row.id,
    date: row.date,
    desc: row.description,
    amount: units(row.price_cents),
    cost: row.cost_cents === null ? null : units(row.cost_cents),
    ship: units(row.shipping_cents),
    other: units(row.other_costs_cents),
    region: row.region,
    method: row.method,
    inv: row.invoice_number ?? "",
    status: row.status,
    buyerId: row.buyer_id ?? "",
    stockItemId: row.stock_item_id ?? "",
  };
}

export function listSales(db: Db): Sale[] {
  return (db.prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE deleted_at IS NULL ORDER BY date DESC, created_at DESC`).all() as SaleRow[]).map(toSale);
}

export function listBuyers(db: Db): Buyer[] {
  const rows = db.prepare("SELECT id, name, email, street, postal_code, city, country FROM buyers WHERE deleted_at IS NULL ORDER BY name").all() as BuyerRow[];
  return rows.map((row) => ({ id: row.id, name: row.name, email: row.email, street: row.street, postalCode: row.postal_code, city: row.city, country: row.country }));
}

/** Stock with, for each item, the sale it went to ("" while still in stock). */
export function listStock(db: Db): StockItem[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.description, i.purchase_price_cents, i.purchase_date, i.source, s.id AS sale_id
       FROM stock_items i LEFT JOIN sales s ON s.stock_item_id = i.id AND s.deleted_at IS NULL
       WHERE i.deleted_at IS NULL ORDER BY i.purchase_date DESC, i.created_at DESC`,
    )
    .all() as StockRow[];
  return rows.map((row) => ({ id: row.id, desc: row.description, cost: units(row.purchase_price_cents), date: row.purchase_date, source: row.source, saleId: row.sale_id ?? "" }));
}

// ---------- stock ----------

type StockInput = z.infer<typeof stockSchema>;

export function createStockItem(db: Db, input: StockInput): StockItem {
  const id = newId();
  const now = nowIso();
  db.prepare("INSERT INTO stock_items (id, description, purchase_price_cents, purchase_date, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, input.desc, cents(input.cost), input.date, input.source, now, now);
  return listStock(db).find((item) => item.id === id) as StockItem;
}

function requireStockRow(db: Db, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM stock_items WHERE id = ? AND deleted_at IS NULL").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new AppError(404, "That stock item no longer exists.");
  return row;
}

export function updateStockItem(db: Db, id: string, input: StockInput, actor: string): StockItem {
  return transaction(db, () => {
    saveRevision(db, "stock_items", id, "update", requireStockRow(db, id), actor);
    db.prepare("UPDATE stock_items SET description = ?, purchase_price_cents = ?, purchase_date = ?, source = ?, updated_at = ? WHERE id = ?").run(input.desc, cents(input.cost), input.date, input.source, nowIso(), id);
    return listStock(db).find((item) => item.id === id) as StockItem;
  });
}

export function deleteStockItem(db: Db, id: string, actor: string): void {
  transaction(db, () => {
    const before = requireStockRow(db, id);
    if (db.prepare("SELECT 1 FROM sales WHERE stock_item_id = ? AND deleted_at IS NULL").get(id)) {
      throw new AppError(409, "That item is on a sale. Remove it from the sale first.");
    }
    saveRevision(db, "stock_items", id, "delete", before, actor);
    db.prepare("UPDATE stock_items SET deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), id);
  });
}

// ---------- sales ----------

/** The next free invoice number for a year. Numbers of deleted sales stay taken. */
export function suggestInvoiceNumber(db: Db, year: number): string {
  const used = (db.prepare("SELECT invoice_number FROM sales WHERE invoice_number IS NOT NULL").all() as { invoice_number: string }[]).map((row) => row.invoice_number);
  return nextInvoiceNumber(used, year);
}

/** Finds or creates the buyer of a sale. A returning buyer (same name and postal code) is reused, not stored twice. */
function resolveBuyer(db: Db, buyer: NonNullable<SaleInput["buyer"]>, actor: string): string {
  const now = nowIso();
  const existing = (
    buyer.id
      ? db.prepare("SELECT * FROM buyers WHERE id = ? AND deleted_at IS NULL").get(buyer.id)
      : db.prepare("SELECT * FROM buyers WHERE deleted_at IS NULL AND lower(name) = lower(?) AND lower(postal_code) = lower(?)").get(buyer.name, buyer.postalCode)
  ) as (Record<string, unknown> & { id: string }) | undefined;
  if (buyer.id && !existing) throw new AppError(400, "That buyer no longer exists.");

  if (existing) {
    saveRevision(db, "buyers", existing.id, "update", existing, actor);
    db.prepare("UPDATE buyers SET name = ?, email = ?, street = ?, postal_code = ?, city = ?, country = ?, updated_at = ? WHERE id = ?").run(buyer.name, buyer.email, buyer.street, buyer.postalCode, buyer.city, buyer.country, now, existing.id);
    return existing.id;
  }
  const id = newId();
  db.prepare("INSERT INTO buyers (id, name, email, street, postal_code, city, country, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, buyer.name, buyer.email, buyer.street, buyer.postalCode, buyer.city, buyer.country, now, now);
  return id;
}

/** Creates a sale, or updates the one with `saleId`. Returns it with the refreshed buyer and stock lists. */
export function saveSale(db: Db, input: SaleInput, actor: string, saleId?: string): { sale: Sale; buyers: Buyer[]; stock: StockItem[] } {
  if (input.status === "complete") {
    const missing = missingInvoiceFields(input);
    if (missing.length > 0) throw new AppError(422, `Not complete yet. Still missing: ${missing.join(", ")}.`);
  }

  return transaction(db, () => {
    const before = saleId ? (db.prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE id = ? AND deleted_at IS NULL`).get(saleId) as SaleRow | undefined) : undefined;
    if (saleId && !before) throw new AppError(404, "That sale no longer exists.");

    if (input.inv) {
      const taken = db.prepare("SELECT id FROM sales WHERE invoice_number = ?").get(input.inv) as { id: string } | undefined;
      if (taken && taken.id !== saleId) throw new AppError(409, `${input.inv} is already used on another sale.`);
    }
    if (input.stockItemId) {
      requireStockRow(db, input.stockItemId);
      const sold = db.prepare("SELECT id FROM sales WHERE stock_item_id = ? AND deleted_at IS NULL").get(input.stockItemId) as { id: string } | undefined;
      if (sold && sold.id !== saleId) throw new AppError(409, "That stock item is already sold.");
    }

    const buyerId = input.buyer ? resolveBuyer(db, input.buyer, actor) : null;
    const now = nowIso();
    const values = [input.date, input.desc, cents(input.amount), input.cost === null ? null : cents(input.cost), cents(input.ship), cents(input.other), input.region, input.method, input.inv || null, input.status, buyerId, input.stockItemId || null];

    const id = saleId ?? newId();
    if (before) {
      saveRevision(db, "sales", id, "update", before, actor);
      db.prepare(
        `UPDATE sales SET date = ?, description = ?, price_cents = ?, cost_cents = ?, shipping_cents = ?, other_costs_cents = ?, region = ?, method = ?,
           invoice_number = ?, status = ?, buyer_id = ?, stock_item_id = ?, updated_at = ? WHERE id = ?`,
      ).run(...values, now, id);
    } else {
      db.prepare(
        `INSERT INTO sales (date, description, price_cents, cost_cents, shipping_cents, other_costs_cents, region, method,
           invoice_number, status, buyer_id, stock_item_id, id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...values, id, now, now);
    }
    const row = db.prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE id = ?`).get(id) as SaleRow;
    return { sale: toSale(row), buyers: listBuyers(db), stock: listStock(db) };
  });
}

/** Marks a sale as deleted. Its stock item is free again; its invoice number stays taken. */
export function deleteSale(db: Db, id: string, actor: string): void {
  transaction(db, () => {
    const before = db.prepare(`SELECT ${SALE_COLUMNS} FROM sales WHERE id = ? AND deleted_at IS NULL`).get(id) as SaleRow | undefined;
    if (!before) throw new AppError(404, "That sale no longer exists.");
    saveRevision(db, "sales", id, "delete", before, actor);
    db.prepare("UPDATE sales SET deleted_at = ?, updated_at = ?, stock_item_id = NULL WHERE id = ?").run(nowIso(), nowIso(), id);
  });
}
