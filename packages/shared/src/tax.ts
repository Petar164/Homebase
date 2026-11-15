// Tax estimates for a Dutch sole proprietor (eenmanszaak) who resells
// second-hand goods under the margin scheme. These are estimates to plan with,
// not a tax return.

import type { LedgerEntry, Sale, Settings } from "./types.ts";

/** One money movement, the common shape of a sale and a ledger entry. */
export type Tx = {
  date: string;
  amount: number;
  kind: "in" | "out";
  area: string;
  cost?: number | null;
  ship?: number;
  other?: number;
  region?: string;
  vat?: boolean;
};

/** Sales and ledger entries as one list, so totals can be computed in one pass. */
export function allTx(ledger: LedgerEntry[], sales: Sale[]): Tx[] {
  const fromSales: Tx[] = sales.map((s) => ({
    date: s.date,
    amount: s.amount,
    kind: "in",
    area: "business",
    cost: s.cost,
    ship: s.ship,
    other: s.other,
    region: s.region,
  }));
  return [...ledger, ...fromSales];
}

/**
 * Margin scheme (margeregeling): VAT is rate/(100+rate) of the profit per
 * item (sale price minus purchase price). Nothing is due on sales outside the
 * EU. A sale without a purchase price counts VAT on the full price, so a
 * missing number can only make the estimate too high, never too low.
 */
export function saleVat(t: Pick<Tx, "amount" | "cost" | "region">, rate: number): number {
  if (t.region === "world") return 0;
  const base = typeof t.cost === "number" ? Math.max(0, t.amount - t.cost) : t.amount;
  return (base * rate) / (1 + rate);
}

export type TaxEstimate = {
  count: number;
  salesCount: number;
  sales: number;
  vatQ: number;
  vatYear: number;
  revenue: number;
  cogs: number;
  costs: number;
  missing: number;
  profit: number;
};

export function taxEstimate(
  items: Tx[],
  settings: Pick<Settings, "vatRate">,
  year: number,
  quarter: number,
): TaxEstimate {
  const r = (Number(settings.vatRate) || 0) / 100;
  const o: TaxEstimate = {
    count: 0, salesCount: 0, sales: 0, vatQ: 0, vatYear: 0,
    revenue: 0, cogs: 0, costs: 0, missing: 0, profit: 0,
  };
  for (const t of items) {
    if (t.area !== "business" || t.date.slice(0, 4) !== String(year)) continue;
    o.count++;
    const q = Math.floor((Number(t.date.slice(5, 7)) - 1) / 3) + 1;
    if (t.kind === "in") {
      const v = saleVat(t, r);
      o.salesCount++;
      o.sales += t.amount;
      o.revenue += t.amount - v;
      o.vatYear += v;
      if (q === quarter) o.vatQ += v;
      if (typeof t.cost === "number") o.cogs += t.cost;
      else o.missing++;
      o.costs += (Number(t.ship) || 0) + (Number(t.other) || 0);
    } else {
      // A business expense with reclaimable VAT lowers the VAT to pay.
      const reclaim = t.vat ? (t.amount * r) / (1 + r) : 0;
      o.costs += t.amount - reclaim;
      o.vatYear -= reclaim;
      if (q === quarter) o.vatQ -= reclaim;
    }
  }
  o.profit = o.revenue - o.cogs - o.costs;
  return o;
}

/** Dutch income tax 2026, box 1, below the hours criterion, no other income. */
const NL2026 = {
  b1: 38883, b2: 78426, r1: 0.3575, r2: 0.3756, r3: 0.495,
  mkb: 0.127, ahkMax: 3115, ahkFrom: 29736, ahkRate: 0.06398,
  zvwRate: 0.0485, zvwMax: 79409,
};

function arbeidskorting2026(a: number): number {
  if (a <= 0) return 0;
  if (a <= 11965) return 0.08324 * a;
  if (a <= 25845) return 996 + 0.31009 * (a - 11965);
  if (a <= 45592) return 5300 + 0.0195 * (a - 25845);
  if (a < 132920) return Math.max(0, 5685 - 0.0651 * (a - 45592));
  return 0;
}

export type IncomeTax = {
  profit: number; mkb: number; taxable: number; gross: number;
  ahk: number; ak: number; incomeTax: number; zvw: number; total: number;
};

export function incomeTaxNL(profit: number): IncomeTax {
  const c = NL2026;
  const p = Math.max(0, profit);
  const mkb = p * c.mkb;
  const tx = p - mkb;
  const gross =
    Math.min(tx, c.b1) * c.r1 +
    Math.max(0, Math.min(tx, c.b2) - c.b1) * c.r2 +
    Math.max(0, tx - c.b2) * c.r3;
  const ahk = Math.max(0, c.ahkMax - Math.max(0, tx - c.ahkFrom) * c.ahkRate);
  const ak = arbeidskorting2026(p);
  // Credits can lower the tax to zero but never below it.
  const ahkUsed = Math.min(gross, ahk);
  const akUsed = Math.min(gross - ahkUsed, ak);
  const incomeTax = gross - ahkUsed - akUsed;
  const zvw = Math.min(tx, c.zvwMax) * c.zvwRate;
  return { profit: p, mkb, taxable: tx, gross, ahk: ahkUsed, ak: akUsed, incomeTax, zvw, total: incomeTax + zvw };
}
