import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * A UUID (version 7). It starts with the time in milliseconds, so ids sort
 * in the order they were created, and ends in random bits, so they cannot
 * collide or be guessed.
 */
export function newId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Writes a file so that it is either fully the old content or fully the new
 * content, never half of each: write to a temporary file, force it to disk,
 * then rename it over the target (a rename is a single step for the system).
 */
export function writeFileAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, file);
}

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export const consoleLogger: Logger = {
  info: (message) => console.log(`${nowIso()} ${message}`),
  warn: (message) => console.warn(`${nowIso()} WARN ${message}`),
  error: (message) => console.error(`${nowIso()} ERROR ${message}`),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
