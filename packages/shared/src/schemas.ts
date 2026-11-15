// What the server accepts. Every write goes through one of these schemas
// before it touches the database (rule: never trust the browser). A schema
// only lets through the fields it names, with the types and limits it states.

import { z } from "zod";
import { INVOICE_PATTERN } from "./sales.ts";
import { CURRENCIES } from "./types.ts";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-01-31.")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "That date does not exist.");
const optionalDay = z.union([day, z.literal("")]);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:30.");
const optionalTime = z.union([time, z.literal("")]);
const text = (max: number) => z.string().trim().min(1, "This cannot be empty.").max(max);
const optionalText = (max: number) => z.string().trim().max(max);

/** An amount of money in whole units, at most two decimals, within a sane range. */
const money = z
  .number()
  .finite()
  .min(0)
  .max(10_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "Use at most two decimals.");
const positiveMoney = money.refine((n) => n > 0, "Enter an amount above zero.");
const count = z.number().int().min(0).max(1_000_000_000);
const weekdayNumber = z.number().int().min(1).max(7);
const logPoint = z.object({ d: day, n: z.number().finite().min(0).max(1e12) });

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

const taskArea = z.enum([
  "inbox", "taxes", "business", "school", "coding", "career", "money", "health", "home", "social", "creative",
]);
const repeat = z.enum(["", "w", "m"]);

export const taskCreateSchema = z.object({
  title: text(200),
  area: taskArea,
  due: optionalDay.default(""),
  repeat: repeat.default(""),
  note: optionalText(500).default(""),
});

export const taskUpdateSchema = z
  .object({
    title: text(200),
    area: taskArea,
    due: optionalDay,
    repeat,
    note: optionalText(500),
    done: z.boolean(),
    // The day it was done, as the browser's calendar sees it.
    doneAt: optionalDay,
  })
  .partial();

export const eventSchema = z
  .object({
    title: text(120),
    cat: z.enum(["", "gym", "mma"]),
    date: day,
    s: optionalTime,
    e: optionalTime,
    repeat: z.enum(["", "w"]),
    until: optionalDay,
  })
  .refine((v) => !(v.s && v.e) || v.e > v.s, "The end time has to be after the start time.");

export const trainingSchema = z.object({
  date: day,
  time: optionalTime,
  kind: z.enum(["gym", "mma"]),
});

const ledgerArea = z.enum(["unsorted", "business", "personal", "school", "transfer"]);

export const ledgerSchema = z.object({
  date: day,
  desc: text(140),
  amount: positiveMoney,
  kind: z.enum(["in", "out"]),
  area: ledgerArea,
  cat: optionalText(60).default(""),
  vat: z.boolean().default(false),
});

export const ledgerUpdateSchema = ledgerSchema.partial();

export const ledgerImportSchema = z.object({
  rows: z
    .array(
      z.object({
        date: day,
        desc: text(140),
        amount: positiveMoney,
        kind: z.enum(["in", "out"]),
        area: ledgerArea.default("unsorted"),
        cat: optionalText(60).default(""),
        // Identifies the source row, so importing twice adds nothing.
        k: text(300),
      }),
    )
    .max(5000),
});

export const buyerSchema = z.object({
  name: text(120),
  email: z.union([z.email().max(200), z.literal("")]).default(""),
  street: optionalText(160).default(""),
  postalCode: optionalText(20).default(""),
  city: optionalText(100).default(""),
  country: optionalText(60).default(""),
});

export const saleSchema = z.object({
  date: day,
  desc: text(140),
  amount: positiveMoney,
  cost: money.nullable(),
  ship: money.default(0),
  other: money.default(0),
  region: z.enum(["NL", "EU", "world"]),
  method: text(40),
  inv: z.union([z.string().regex(INVOICE_PATTERN, "The invoice number must look like FV-0001-2026."), z.literal("")]),
  status: z.enum(["draft", "complete"]),
  // "" means: not picked from stock.
  stockItemId: optionalText(40).default(""),
  // null means: no buyer details yet.
  buyer: buyerSchema.extend({ id: optionalText(40).default("") }).nullable(),
});

export const stockSchema = z.object({
  desc: text(140),
  cost: money,
  date: day,
  source: optionalText(80).default(""),
});

export const socialSchema = z.object({
  name: text(80),
  platform: optionalText(40).default(""),
  status: z.enum(["active", "banned"]),
  goal: count.default(0),
  log: z.array(logPoint).max(1000),
});

export const settingsSchema = z
  .object({
    currency: z.enum(CURRENCIES as [string, ...string[]]),
    vatRate: z.number().finite().min(0).max(100),
    classes: z
      .array(
        z
          .object({ d: weekdayNumber, s: time, e: time, name: text(80), room: optionalText(80).default("") })
          .refine((c) => c.e > c.s, "The end time has to be after the start time."),
      )
      .max(80),
    classesEnd: optionalDay,
    mmaSlots: z.array(z.object({ d: weekdayNumber, t: time })).max(30),
    savings: z.object({ have: money, goal: money, log: z.array(logPoint).max(120) }),
    webshop: z.object({ orders: count, revenue: money, shipped: count, asOf: optionalDay }),
  })
  .partial();

export type SaleInput = z.infer<typeof saleSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
