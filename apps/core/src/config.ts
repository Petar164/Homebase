import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { DataPaths } from "./paths.ts";
import { writeFileAtomic } from "./util.ts";

// Settings the core needs before the database is open. They live in
// config.json in the data folder (never in the app folder), so they survive
// updates and belong to this machine.

const configSchema = z.object({
  http: z
    .object({
      // 127.0.0.1 means: only programs on this machine can connect.
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(7117),
    })
    .prefault({}),
  backup: z
    .object({
      /** Hours between scheduled snapshots. */
      intervalHours: z.number().positive().default(24),
      /** Extra backup folders, for example on the external drive. */
      mirrors: z.array(z.string().min(1)).default([]),
      retention: z
        .object({
          dailyDays: z.number().int().min(1).default(7),
          weeklyWeeks: z.number().int().min(0).default(8),
          monthlyMonths: z.number().int().min(0).default(24),
          safetyDays: z.number().int().min(1).default(30),
        })
        .prefault({}),
    })
    .prefault({}),
  ai: z
    .object({
      /** "auto": a local model when one is running, otherwise the cloud. */
      prefer: z.enum(["auto", "local", "cloud"]).default("auto"),
      /** When true, small reversible changes (tier 1) run without asking. */
      autoApproveTier1: z.boolean().default(false),
      cloud: z
        .object({
          model: z.string().default("claude-opus-5-5"),
          /** Hard stop for cloud spending per calendar month, in US dollars. */
          monthlyCapUsd: z.number().min(0).default(10),
          /** Prices in US dollars per million tokens, used to track spending. */
          pricePerMTok: z
            .record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) }))
            .default({ "claude-opus-5-5": { input: 4, output: 20 }, "claude-haiku-5-5": { input: 0.1, output: 0.5 } }),
        })
        .prefault({}),
      local: z
        .object({
          /** Where Ollama listens. */
          baseUrl: z.string().default("http://127.0.0.1:11434"),
          /** The local model to use. Empty means: no local model set up. */
          model: z.string().default(""),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return configSchema.parse({});
}

/**
 * Reads config.json. A missing file means defaults. A broken file is an
 * error on purpose: quietly replacing it could, for example, drop the list
 * of backup folders.
 */
export function loadConfig(paths: DataPaths, env: NodeJS.ProcessEnv = process.env): Config {
  let raw: unknown = {};
  if (existsSync(paths.configFile)) {
    try {
      raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
    } catch {
      throw new Error(`${paths.configFile} is not valid JSON. Fix or remove it; nothing was changed.`);
    }
  }
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${paths.configFile}: ${issue?.path.join(".")} ${issue?.message}. Nothing was changed.`);
  }
  const config = result.data;
  if (env.HOMEBASE_PORT) config.http.port = Number(env.HOMEBASE_PORT);
  return config;
}

export function saveConfig(paths: DataPaths, config: Config): void {
  writeFileAtomic(paths.configFile, `${JSON.stringify(configSchema.parse(config), null, 2)}\n`);
}
