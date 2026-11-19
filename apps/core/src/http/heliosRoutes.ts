import type { Approval, CloudStatus, ConversationMessage, ConversationSummary, CoreEvent, HeliosStatus, TurnResult, WebStatus } from "@homebase/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Helios } from "../ai/helios.ts";
import { AppError } from "../errors.ts";
import { saveConfig } from "../config.ts";
import type { EventBus } from "../events.ts";
import type { Instance } from "../instance.ts";
import { audit } from "../security/audit.ts";
import type { VoiceService, VoiceStatus } from "../voice/service.ts";
import { requireElevated } from "./server.ts";

const idParams = z.object({ id: z.string().regex(/^[\w-]{1,64}$/) });
const messageSchema = z.object({
  text: z.string().trim().min(1, "Say something first.").max(4000),
  conversationId: z.string().regex(/^[\w-]{1,64}$/).optional(),
});
const decisionSchema = z.object({ decision: z.enum(["approve", "deny"]) });
const messageOptions = z.object({ reasoning: z.enum(["strong"]).optional() });
const listenSchema = z.object({ action: z.enum(["start", "stop", "cancel"]) });
const saySchema = z.object({ text: z.string().trim().min(1).max(300) });
const voiceSettingsSchema = z
  .object({
    voiceName: z.string().regex(/^[a-z]{2}_[a-z]+$/),
    speed: z.number().min(0.5).max(2),
    gain: z.number().min(0).max(1),
    inputDevice: z.union([z.string().max(200), z.number().int(), z.null()]),
    outputDevice: z.union([z.string().max(200), z.number().int(), z.null()]),
    speakReplies: z.boolean(),
    wakeEnabled: z.boolean(),
    wakeThreshold: z.number().min(0.05).max(0.99),
  })
  .partial();
const webSettingsSchema = z.object({ enabled: z.boolean(), confirmEvery: z.boolean() }).partial();
const cloudSettingsSchema = z.object({ enabled: z.boolean() });
const VOICE_OFF: VoiceStatus = { enabled: false, worker: "off", state: "idle", wakeAvailable: false, wakeEnabled: false, devices: { inputs: [], outputs: [] }, lastError: null, restarts: 0, last: null };

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, result.error.issues[0]?.message ?? "That input is not valid.");
  return result.data;
}

export function registerHeliosRoutes(app: FastifyInstance, helios: Helios, bus: EventBus, voice: VoiceService | null, instance: Instance): void {
  const requireVoice = (): VoiceService => {
    if (!voice) throw new AppError(503, "Voice is switched off on this machine.");
    return voice;
  };
  app.get("/api/helios/status", async (): Promise<HeliosStatus> => helios.status());

  // The event stream: one long-lived response over which the core pushes
  // state changes, new messages and approval requests to the screen
  // (Server-Sent Events). It passes the same host and session checks as
  // every other route before it gets here.
  app.get("/api/stream", (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const send = (event: CoreEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "state", state: helios.currentState });
    const unsubscribe = bus.subscribe(send);
    // A comment line now and then keeps idle connections from being dropped.
    const heartbeat = setInterval(() => response.write(": still here\n\n"), 25_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/conversations", async (): Promise<ConversationSummary[]> => helios.listConversations());

  app.get("/api/conversations/:id/messages", async (request): Promise<ConversationMessage[]> => helios.messages(parse(idParams, request.params).id));

  app.post("/api/helios/message", async (request): Promise<TurnResult> => {
    const input = parse(messageSchema.extend(messageOptions.shape), request.body);
    return helios.handleMessage(input.text, { conversationId: input.conversationId, channel: "text", reasoning: input.reasoning });
  });

  // ---------- voice ----------
  // Talking to HELIOS gives no extra rights: a spoken request takes the same
  // path as a typed one, and these routes need the same login.

  app.get("/api/voice/status", async (): Promise<VoiceStatus> => voice?.status() ?? VOICE_OFF);

  // Push-to-talk: "start" when the button goes down, "stop" when it comes up.
  app.post("/api/voice/listen", async (request) => {
    const { action } = parse(listenSchema, request.body);
    const service = requireVoice();
    if (action === "start") service.listenStart();
    else if (action === "stop") service.listenStop();
    else service.listenCancel();
    return { ok: true };
  });

  app.post("/api/voice/stop-speaking", async () => {
    requireVoice().stopSpeaking();
    return { ok: true };
  });

  app.post("/api/voice/say", async (request) => {
    requireVoice().say(parse(saySchema, request.body).text);
    return { ok: true };
  });

  app.post("/api/voice/restart", async () => {
    requireVoice().restart();
    return { ok: true };
  });

  app.put("/api/voice/settings", async (request) => {
    const input = parse(voiceSettingsSchema, request.body);
    const settings = instance.config.voice;
    const { wakeEnabled, wakeThreshold, ...plain } = input;
    Object.assign(settings, plain);
    if (wakeEnabled !== undefined) settings.wake.enabled = wakeEnabled;
    if (wakeThreshold !== undefined) settings.wake.threshold = wakeThreshold;
    saveConfig(instance.paths, instance.config);
    audit(instance.db, { actor: "owner", action: "voice.settings", detail: { changed: Object.keys(input) } });
    voice?.configure();
    return voice?.status() ?? VOICE_OFF;
  });

  // ---------- web access ----------
  // Switching web access on, or switching "ask every time" off, lets more
  // leave this machine, so it needs the password again (docs/SECURITY.md).
  // Making it stricter never does: "off" has to work at once.

  app.put("/api/web/settings", async (request): Promise<WebStatus> => {
    const input = parse(webSettingsSchema, request.body);
    const settings = instance.config.web;
    const widens = (input.enabled === true && !settings.enabled) || (input.confirmEvery === false && settings.confirmEvery);
    if (widens) requireElevated(request.session);
    Object.assign(settings, input);
    saveConfig(instance.paths, instance.config);
    audit(instance.db, { actor: "owner", action: "web.settings", detail: { enabled: settings.enabled, confirmEvery: settings.confirmEvery } });
    return (await helios.status()).web;
  });

  // The switch for cloud models. On lets conversations leave this machine,
  // so it needs the password again, like any change that widens what HELIOS
  // may do. Off needs nothing and works at once. A key in the .env file
  // does not switch anything on by itself.
  app.put("/api/ai/cloud", async (request): Promise<CloudStatus> => {
    const input = parse(cloudSettingsSchema, request.body);
    const settings = instance.config.ai.cloud;
    if (input.enabled && !settings.allowed) requireElevated(request.session);
    if (input.enabled !== settings.allowed) {
      settings.allowed = input.enabled;
      saveConfig(instance.paths, instance.config);
      audit(instance.db, { actor: "owner", action: "cloud.settings", detail: { enabled: settings.allowed } });
    }
    return (await helios.status()).cloud;
  });

  app.get("/api/approvals", async (): Promise<Approval[]> => helios.pendingApprovals());

  app.post("/api/approvals/:id/decide", async (request) => {
    const { id } = parse(idParams, request.params);
    const { decision } = parse(decisionSchema, request.body);
    const decided = await helios.decide(id, decision, request.session);
    // A web request that was asked for by voice and approved on screen is
    // answered by voice too: the yes is the only part that needs the screen.
    if (voice && decided.approval.web && decided.turn) {
      voice.announce(decided.turn.conversationId, decided.turn.messages.filter((message) => message.role === "assistant").map((message) => message.text));
    }
    return decided;
  });
}
