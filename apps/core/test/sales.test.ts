import type { SaleInput } from "@homebase/shared";
import { describe, expect, it } from "vitest";
import { createStockItem, deleteSale, deleteStockItem, listBuyers, listSales, listStock, saveSale, suggestInvoiceNumber } from "../src/domain/sales.ts";
import { openInstance } from "../src/instance.ts";
import { tempDir, track } from "./helpers.ts";

// Invented data only.
const buyer = { id: "", name: "Sam Example", email: "", street: "1 Sample Street", postalCode: "1234 AB", city: "Sampletown", country: "Netherlands" };
const sale = (overrides: Partial<SaleInput> = {}): SaleInput => ({
  date: "2026-11-10", desc: "Sample jacket", amount: 180, cost: 90, ship: 7.5, other: 0, region: "NL", method: "PayPal",
  inv: "FV-0001-2026", status: "complete", stockItemId: "", buyer, ...overrides,
});
const open = async () => track(await openInstance({ dataDir: tempDir() })).db;

describe("sales", () => {
  it("refuses to call a sale complete while an invoice field is missing", async () => {
    const db = await open();
    expect(() => saveSale(db, sale({ cost: null, buyer: { ...buyer, street: "" } }), "owner")).toThrow(/Still missing: purchase price, street/);
    // The same sale can be saved as a draft and finished later.
    const { sale: draft } = saveSale(db, sale({ cost: null, buyer: null, inv: "", status: "draft" }), "owner");
    const { sale: done } = saveSale(db, sale(), "owner", draft.id);
    expect(done).toMatchObject({ status: "complete", inv: "FV-0001-2026", amount: 180, cost: 90, ship: 7.5 });
    expect(db.prepare("SELECT price_cents, shipping_cents FROM sales").get()).toMatchObject({ price_cents: 18000, shipping_cents: 750 });
  });

  it("uses every invoice number once, also after a sale is deleted", async () => {
    const db = await open();
    expect(suggestInvoiceNumber(db, 2026)).toBe("FV-0001-2026");
    const { sale: first } = saveSale(db, sale(), "owner");
    expect(() => saveSale(db, sale({ desc: "Another item" }), "owner")).toThrow(/already used/);
    expect(suggestInvoiceNumber(db, 2026)).toBe("FV-0002-2026");
    expect(suggestInvoiceNumber(db, 2027)).toBe("FV-0001-2027");

    deleteSale(db, first.id, "owner");
    expect(listSales(db)).toEqual([]);
    expect(suggestInvoiceNumber(db, 2026)).toBe("FV-0002-2026"); // 0001 is not handed out again
    expect(() => saveSale(db, sale(), "owner")).toThrow(/already used/);
  });

  it("sells a stock item once, and frees it when the sale is deleted", async () => {
    const db = await open();
    const item = createStockItem(db, { desc: "Sample jacket", cost: 90, date: "2026-10-01", source: "Sample seller" });
    const { sale: sold, stock } = saveSale(db, sale({ stockItemId: item.id }), "owner");
    expect(stock[0]).toMatchObject({ id: item.id, saleId: sold.id });
    expect(() => saveSale(db, sale({ inv: "FV-0002-2026", stockItemId: item.id }), "owner")).toThrow(/already sold/);
    expect(() => deleteStockItem(db, item.id, "owner")).toThrow(/on a sale/);

    deleteSale(db, sold.id, "owner");
    expect(listStock(db)[0]?.saleId).toBe("");
    expect(saveSale(db, sale({ inv: "FV-0002-2026", stockItemId: item.id }), "owner").sale.stockItemId).toBe(item.id);
  });

  it("recognises a returning buyer instead of storing them twice", async () => {
    const db = await open();
    saveSale(db, sale(), "owner");
    saveSale(db, sale({ inv: "FV-0002-2026", buyer: { ...buyer, name: "sam example", postalCode: "1234 ab", street: "2 New Street" } }), "owner");
    const buyers = listBuyers(db);
    expect(buyers).toHaveLength(1);
    expect(buyers[0]?.street).toBe("2 New Street");
    // The earlier address is kept as a previous version.
    const previous = db.prepare("SELECT data FROM record_revisions WHERE table_name = 'buyers'").get() as { data: string };
    expect(JSON.parse(previous.data)).toMatchObject({ street: "1 Sample Street" });
  });
});
