// Rules for sales and invoice numbers, shared by the browser (to show what is
// missing while typing) and the server (which makes the final decision).

import type { Buyer, Sale } from "./types.ts";

/** Invoice numbers look like FV-0001-2026: a running number, then the year. */
export const INVOICE_PATTERN = /^FV-(\d{4})-(\d{4})$/;

/** The next free invoice number for a year, based on the highest one in use. */
export function nextInvoiceNumber(existing: string[], year: number): string {
  let max = 0;
  for (const inv of existing) {
    const m = INVOICE_PATTERN.exec(inv);
    if (m && m[2] === String(year)) max = Math.max(max, Number(m[1]));
  }
  return `FV-${String(max + 1).padStart(4, "0")}-${year}`;
}

type InvoiceFields = Pick<Sale, "date" | "desc" | "amount" | "cost" | "inv"> & {
  buyer: Pick<Buyer, "name" | "street" | "postalCode" | "city" | "country"> | null;
};

/**
 * Everything an invoice needs. A sale can only be marked complete when this
 * returns an empty list. To change what counts as required, change it here:
 * both the form and the server use this one function.
 */
export function missingInvoiceFields(sale: InvoiceFields): string[] {
  const missing: string[] = [];
  if (!INVOICE_PATTERN.test(sale.inv)) missing.push("invoice number");
  if (!sale.date) missing.push("date");
  if (!sale.desc.trim()) missing.push("item");
  if (!(sale.amount > 0)) missing.push("sale price");
  if (typeof sale.cost !== "number") missing.push("purchase price");
  if (!sale.buyer?.name.trim()) missing.push("buyer name");
  if (!sale.buyer?.street.trim()) missing.push("street");
  if (!sale.buyer?.postalCode.trim()) missing.push("postal code");
  if (!sale.buyer?.city.trim()) missing.push("city");
  if (!sale.buyer?.country.trim()) missing.push("country");
  return missing;
}
