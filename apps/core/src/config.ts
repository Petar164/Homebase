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
      /**
       * "auto": the local model for ordinary requests, a cloud model for
       * hard ones. "local": never the cloud unless the owner asks for
       * stronger reasoning. "cloud": cloud models first.
       */
      prefer: z.enum(["auto", "local", "cloud"]).default("auto"),
      /** When true, small reversible changes (tier 1) run without asking. */
      autoApproveTier1: z.boolean().default(false),
      local: z
        .object({
          /** Where Ollama listens. */
          baseUrl: z.string().default("http://127.0.0.1:11434"),
          /** The local model. Empty means: no local model. */
          model: z.string().default("qwen3.5:4b"),
          /** How much conversation the local model is given, in tokens. More uses more GPU memory. */
          contextTokens: z.number().int().min(1024).max(131072).default(8192),
          /** How long Ollama keeps the model loaded after an answer. */
          keepAlive: z.string().default("10m"),
          /** Lets the model reason before answering. Slower; off for spoken answers. */
          think: z.boolean().default(false),
        })
        .prefault({}),
      cloud: z
        .object({
          /** The data-policy switch. False: nothing is ever sent to a cloud model. */
          enabled: z.boolean().default(true),
          /** Hard reasoning, complex planning, analysis. */
          strongModel: z.string().default("claude-sonnet-5-5"),
          /** Extraction, classification, summaries, background work. */
          lightModel: z.string().default("claude-haiku-5-5"),
          /** How hard each model thinks. Lower answers faster and costs less. */
          effort: z
            .object({
              strong: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
              light: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
            })
            .prefault({}),
          /**
           * The most a single answer may cost in output. It is sent to the
           * API as the limit, so it is also what the budget sets aside
           * before each call.
           */
          maxOutputTokens: z.object({ strong: z.number().int().min(256).default(8000), light: z.number().int().min(256).default(2000) }).prefault({}),
          budget: z
            .object({
              /** A warning is shown once spending this month reaches this, in euros. */
              warnEur: z.number().min(0).default(15),
              /** Cloud calls stop when spending this month would pass this, in euros. */
              capEur: z.number().min(0).default(20),
              /**
               * Prices are in US dollars. One dollar is counted as this many
               * euros (deliberately not less than the real rate), and
               * taxAllowance is added on top for VAT and billing differences.
               */
              usdToEur: z.number().positive().default(1),
              taxAllowance: z.number().min(0).default(0.21),
            })
            .prefault({}),
          /** US dollars per million tokens. The "Above100k" prices apply to prompts over 100,000 tokens. */
          pricePerMTok: z
            .record(
              z.string(),
              z.object({ input: z.number().min(0), output: z.number().min(0), inputAbove100k: z.number().min(0).optional(), outputAbove100k: z.number().min(0).optional() }),
            )
            .default({
              "claude-sonnet-5-5": { input: 2, output: 10 },
              "claude-haiku-5-5": { input: 0.1, output: 0.5, inputAbove100k: 0.5, outputAbove100k: 2.5 },
              "claude-opus-5-5": { input: 4, output: 20 },
            }),
        })
        .prefault({}),
      routing: z
        .object({
          /** A request longer than this many characters counts as a hard one. */
          complexChars: z.number().int().min(50).default(600),
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
