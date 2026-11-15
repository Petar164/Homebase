import { ClaudeProvider } from "./ai/claude.ts";
import { OllamaProvider } from "./ai/ollama.ts";
import { StandInProvider } from "./ai/standin.ts";
import { buildServer } from "./http/server.ts";
import { openInstance, StartupRefused } from "./instance.ts";
import { runBackupCycle } from "./jobs/backups.ts";
import { APP_VERSION, defaultDataDir, WEB_DIST_DIR } from "./paths.ts";
import { ownerExists } from "./security/owner.ts";
import { consoleLogger } from "./util.ts";

// The core: one long-running program. It opens the data folder (applying
// every safety rule in instance.ts), serves the API and the screen, and
// keeps backups up to date. The screen is only a view of it; closing the
// browser changes nothing here.

const BACKUP_CHECK_MINUTES = 15;
const log = consoleLogger;

try {
  const instance = await openInstance({ dataDir: defaultDataDir(), log });
  const { host, port } = instance.config.http;
  const extraHosts = (process.env.HOMEBASE_DEV_HOSTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  // The models HELIOS may use. Which one answers is decided per request
  // (see ai/policy.ts): local first, the cloud behind the approval gate,
  // and the rule-based stand-in only while no real model is set up.
  const { ai } = instance.config;
  const providers = [
    new StandInProvider(),
    new OllamaProvider({ baseUrl: ai.local.baseUrl, model: ai.local.model, contextTokens: ai.local.contextTokens, keepAlive: ai.local.keepAlive, think: ai.local.think }),
    new ClaudeProvider({ role: "strong", model: ai.cloud.strongModel, effort: ai.cloud.effort.strong, maxOutputTokens: ai.cloud.maxOutputTokens.strong }),
    new ClaudeProvider({ role: "light", model: ai.cloud.lightModel, effort: ai.cloud.effort.light, maxOutputTokens: ai.cloud.maxOutputTokens.light }),
  ];
  const { app, helios } = await buildServer({ instance, log, webDir: WEB_DIST_DIR, extraHosts, providers });
  await app.listen({ host, port });

  log.info(`Home Base ${APP_VERSION} is running at http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);
  log.info(`Data folder: ${instance.paths.root}`);
  if (!ownerExists(instance.db)) log.warn("No owner account yet. Create one with:  npm run homebase -- owner set-password");
  const ready = (await helios.status()).models.filter((model) => model.available && model.id !== "standin");
  log.info(ready.length > 0 ? `HELIOS models: ${ready.map((model) => `${model.model} (${model.location})`).join(", ")}` : "HELIOS has no model connected yet; the stand-in answers.");

  const backupCycle = () => runBackupCycle(instance, log).catch((error: Error) => log.error(`Backup cycle failed: ${error.message}`));
  void backupCycle();
  const timer = setInterval(backupCycle, BACKUP_CHECK_MINUTES * 60 * 1000);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await app.close();
    instance.close();
    log.info("Home Base stopped.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (error) {
  if (error instanceof StartupRefused) {
    console.error(`\nHome Base did not start.\n\n${error.message}\n`);
    for (const line of error.help) console.error(`  ${line}`);
    process.exit(2);
  }
  throw error;
}
