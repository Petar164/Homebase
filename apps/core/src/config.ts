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
          think: z.union([z.boolean(), z.enum(["low", "medium", "high"])]).default(false),
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
  web: z
    .object({
      /**
       * The switch for the public internet. False: HELIOS can neither search
       * the web nor open a page, and says so when asked. Off until the owner
       * turns it on.
       */
      enabled: z.boolean().default(false),
      /**
       * True: every search and every page needs a yes on screen. False: only
       * requests that could carry private details do (docs/WEB-ACCESS.md).
       */
      confirmEvery: z.boolean().default(false),
      search: z
        .object({
          /** "auto" uses the service whose key is in the environment, Brave first. */
          provider: z.enum(["auto", "brave", "tavily"]).default("auto"),
          /** Another address for the search service, for a proxy or a test. Empty means the service's own. */
          baseUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default(""),
          /** Most results one search gives the model. */
          maxResults: z.number().int().min(1).max(10).default(5),
          /** Most characters of one result's summary. */
          snippetChars: z.number().int().min(60).max(1000).default(240),
          /** Prefer results from this country (two letters, Brave only). Empty means no preference. */
          country: z.string().regex(/^([A-Za-z]{2})?$/).default(""),
          safeSearch: z.enum(["off", "moderate", "strict"]).default("moderate"),
          timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
        })
        .prefault({}),
      page: z
        .object({
          /** The whole time one page may take, redirects included. */
          timeoutMs: z.number().int().min(1000).max(60_000).default(12_000),
          /** Most bytes read from one page. A longer page is read up to here. */
          maxBytes: z.number().int().min(10_000).max(10_000_000).default(2_000_000),
          maxRedirects: z.number().int().min(0).max(10).default(5),
          /** Most characters of one page handed to the model. A small context window narrows this further. */
          maxChars: z.number().int().min(500).max(40_000).default(6000),
        })
        .prefault({}),
      /** Most searches and most pages for one question, and most page fetches running at the same time. */
      limits: z
        .object({
          searchesPerTurn: z.number().int().min(1).max(10).default(3),
          pagesPerTurn: z.number().int().min(1).max(10).default(4),
          concurrent: z.number().int().min(1).max(8).default(2),
        })
        .prefault({}),
    })
    .prefault({}),
  voice: z
    .object({
      /** Starts the voice worker (apps/voice) with the core. Off until speech is set up on this machine. */
      enabled: z.boolean().default(false),
      /** How to start the worker. Empty means the built-in way: uv, from apps/voice. */
      command: z.array(z.string()).default([]),
      /** Speech recogniser: the preferred model, or the fallback. */
      stt: z.enum(["parakeet-unified", "parakeet-tdt-v2"]).default("parakeet-unified"),
      /** The voice model file: "int8" is smaller and faster, "full" is full precision. */
      tts: z.enum(["int8", "full"]).default("int8"),
      voiceName: z.string().default("am_michael"),
      speed: z.number().min(0.5).max(2).default(1),
      /** Playback volume, from 0 to 1. */
      gain: z.number().min(0).max(1).default(1),
      /** Audio devices by name or number. Null means the system default. */
      inputDevice: z.union([z.string(), z.number(), z.null()]).default(null),
      outputDevice: z.union([z.string(), z.number(), z.null()]).default(null),
      /** Speak HELIOS's answers to spoken questions. */
      speakReplies: z.boolean().default(true),
      /** After HELIOS stops speaking, ignore the microphone this long (milliseconds). */
      guardMs: z.number().int().min(0).max(5000).default(500),
      wake: z
        .object({
          enabled: z.boolean().default(false),
          /** The wake model file in the models folder. "Hey Helios" needs its own trained model. */
          model: z.string().default("hey_jarvis_v0.1.onnx"),
          /** How sure the model has to be, from 0 to 1. Higher means fewer false alarms. */
          threshold: z.number().min(0.05).max(0.99).default(0.5),
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
