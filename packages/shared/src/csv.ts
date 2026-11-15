// Reads a bank's CSV export (built for Rabobank, tolerant of others) into
// plain rows. Runs in the browser; the server validates the rows again before
// saving them.

import { parseDate } from "./dates.ts";

/** "1.234,56" or "1,234.56" or "-12,5" -> number. NaN when there is no digit. */
export function parseAmount(input: string): number {
  let s = String(input).replace(/[^\d,.\-+]/g, "");
  if (!/\d/.test(s)) return NaN;
  const neg = s.includes("-");
  s = s.replace(/[-+]/g, "");
  const c = s.lastIndexOf(",");
  const d = s.lastIndexOf(".");
  if (c > -1 && d > -1) s = c > d ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (c > -1) s = s.split(",").length > 2 ? s.replace(/,/g, "") : s.replace(",", ".");
  else if (d > -1 && s.split(".").length > 2) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return neg ? -n : n;
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0];
  const delim = [";", "\t", ","]
    .map((x) => [x, first.split(x).length] as const)
    .sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

export type BankRow = { date: string; desc: string; amount: number; kind: "in" | "out" };

/** Bank export -> rows. Throws an Error with a readable message. */
export function bankRows(text: string): { rows: BankRow[]; bad: number } {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("That file has no transaction rows.");
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const find = (re: RegExp, not?: RegExp) => h.findIndex((x) => re.test(x) && !(not && not.test(x)));
  const di = find(/dat/);
  const ai = find(/bedrag|amount/, /saldo|balance|fee/);
  const ki = find(/^af.?bij$|debit.?credit|^type$|^direction$/);
  const ni = find(/naam tegenpartij|^naam|name|payee|merchant|tegenpartij/);
  const oi = h.findIndex((x, i) => i !== ni && /omschrijving|description|mededeling|reference/.test(x));
  const descIdx = [ni, oi].filter((i) => i > -1);
  if (di < 0 || ai < 0) {
    throw new Error(`Couldn't find a date and an amount column. Columns in the file: ${rows[0].join(", ")}`);
  }
  const out: BankRow[] = [];
  let bad = 0;
  for (const r of rows.slice(1)) {
    const date = parseDate(r[di] || "");
    const n = parseAmount(r[ai] || "");
    if (!date || isNaN(n) || n === 0) { bad++; continue; }
    let kind: "in" | "out" = n < 0 ? "out" : "in";
    if (ki > -1) {
      const k = (r[ki] || "").trim().toLowerCase();
      if (/^(af|debit|out)/.test(k)) kind = "out";
      else if (/^(bij|credit|in)/.test(k)) kind = "in";
    }
    const desc = descIdx.map((i) => (r[i] || "").trim()).filter(Boolean).join(" · ").slice(0, 140) || "(no description)";
    out.push({ date, desc, amount: Math.round(Math.abs(n) * 100) / 100, kind });
  }
  return { rows: out, bad };
}

/** Identifies a bank row, so importing the same file twice adds nothing. */
export function txKey(t: BankRow): string {
  return `${t.date}|${t.kind}|${t.amount.toFixed(2)}|${t.desc}`;
}
