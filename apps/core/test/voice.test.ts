import { describe, expect, it } from "vitest";
import { Helios } from "../src/ai/helios.ts";
import { StandInProvider } from "../src/ai/standin.ts";
import { type ChatRequest, type ChatResponse, type ModelProvider, ProviderError } from "../src/ai/types.ts";
import { EventBus } from "../src/events.ts";
import { buildServer } from "../src/http/server.ts";
import { openInstance } from "../src/instance.ts";
import { createSession, SESSION_COOKIE } from "../src/security/sessions.ts";
import { workerEnv } from "../src/voice/process.ts";
import type { VoiceCommand, VoiceEvent, VoiceTransport } from "../src/voice/protocol.ts";
import { isOwnVoice, VoiceService } from "../src/voice/service.ts";
import { silentLogger } from "../src/util.ts";
import { insertTask, tempDir, track } from "./helpers.ts";

/** A voice worker that exists only in the test: it records commands and says what the test tells it to. */
class FakeWorker implements VoiceTransport {
  sent: VoiceCommand[] = [];
  alive = false;
  private eventListener: (event: VoiceEvent) => void = () => {};
  private exitListener: () => void = () => {};
  onEvent(listener: (event: VoiceEvent) => void) {
    this.eventListener = listener;
  }
  onExit(listener: () => void) {
    this.exitListener = listener;
  }
  start() {
    this.alive = true;
  }
  send(command: VoiceCommand) {
    if (!this.alive) return false;
    this.sent.push(command);
    return true;
  }
  stop() {
    this.crash();
  }
  emit(event: VoiceEvent) {
    this.eventListener(event);
  }
  crash() {
    if (!this.alive) return;
    this.alive = false;
    this.exitListener();
  }
  spoken() {
    return this.sent.filter((command) => command.type === "speak").map((command) => (command as { text: string }).text);
  }
}

/** A model that writes its answer in pieces, the way a real one streams. */
class StreamingProvider implements ModelProvider {
  readonly id = "local";
  readonly role = "local" as const;
  readonly location = "local" as const;
  readonly model = "streaming-model";
  failWith: Error | null = null;
  /** Called before each piece is written: a test can let time pass here. */
  beforePiece: (index: number) => void = () => {};
  private pieces: string[];
  constructor(pieces: string[]) {
    this.pieces = pieces;
  }
  async available() {
    return true;
  }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (this.failWith) throw this.failWith;
    for (const [index, piece] of this.pieces.entries()) {
      this.beforePiece(index);
      request.onText?.(piece);
    }
    return { text: this.pieces.join(""), toolCalls: [], stop: "end", usage: { inputTokens: 1, outputTokens: 1 }, model: this.model };
  }
}

async function setup(providers: ModelProvider[] = [new StandInProvider()]) {
  const instance = track(await openInstance({ dataDir: tempDir() }));
  const bus = new EventBus();
  const states: string[] = [];
  bus.subscribe((event) => event.type === "state" && states.push(event.state));
  const logged: string[] = [];
  const log = { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
  const helios = new Helios({ instance, providers, bus, log });
  const workers: FakeWorker[] = [];
  const scheduled: { work: () => void; ms: number }[] = [];
  let clock = 1_000_000;
  const voice = new VoiceService({
    helios,
    bus,
    log,
    settings: instance.config.voice,
    createTransport: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    schedule: (work, ms) => scheduled.push({ work, ms }),
    now: () => clock,
  });
  voice.start();
  const worker = () => workers.at(-1) as FakeWorker;
  worker().emit({ type: "ready", pid: 1, wake_available: true, vad_available: true });
  /** Waits until the spoken answer is complete. */
  const answered = async () => {
    for (let i = 0; i < 200 && !worker().sent.some((command) => command.type === "speak_end"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { instance, helios, voice, worker, workers, scheduled, states, logged, answered, advance: (ms: number) => (clock += ms) };
}

const heard = (text: string): VoiceEvent => ({ type: "transcript", text, audio_ms: 1800, decode_ms: 120 });

describe("speech becomes conversation", () => {
  it("sends its settings to the worker as soon as it is up", async () => {
    const { worker } = await setup();
    expect(worker().sent[0]).toMatchObject({ type: "configure", config: { voice: "am_michael", wake_enabled: false, guard_ms: 500 } });
    expect(worker().sent[1]).toEqual({ type: "devices" });
  });

  it("turns what was heard into a stored turn and speaks the answer", async () => {
    const { instance, worker, answered, voice } = await setup();
    insertTask(instance, "t1", "Hand in the assignment");
    worker().emit(heard("What is due this week?"));
    await answered();

    const conversation = instance.db.prepare("SELECT channel, title FROM conversations").get();
    expect(conversation).toEqual({ channel: "voice", title: "What is due this week?" });
    const answer = instance.db.prepare("SELECT text FROM messages WHERE role = 'assistant' AND text != ''").get() as { text: string };
    expect(worker().spoken().join(" ")).toBe(answer.text);
    expect(worker().spoken().length).toBeGreaterThan(1); // sentence by sentence
    const commands = worker().sent.map((command) => command.type);
    expect(commands.at(-1)).toBe("speak_end");
    expect(voice.status().last).toEqual({ audioMs: 1800, transcribeMs: 120, firstSoundMs: null, sinceListeningEnded: null });
  });

  it("times a spoken turn from the release of the talk button to the first sound", async () => {
    const model = new StreamingProvider(["First sentence here. ", "Second one follows."]);
    const { voice, worker, answered, advance, logged } = await setup([model]);
    model.beforePiece = (index) => advance(index === 0 ? 100 : 500); // the model thinks, then writes
    voice.listenStart();
    advance(2_000); // the owner speaks
    voice.listenStop(); // the clock starts here, not when the worker reacts
    advance(40);
    worker().emit({ type: "state", state: "transcribing" });
    advance(260);
    worker().emit(heard("Tell me something")); // the transcript arrives 300 ms after the release
    await answered(); // first sentence after 100 ms more, the second 500 ms after that
    advance(200);
    // A voice that is only being tried out is not this answer's first sound.
    worker().emit({ type: "speech_started", id: "a-voice-being-tried-out", latency_ms: 90 });
    expect(voice.status().last?.sinceListeningEnded?.firstSoundMs).toBeNull();
    advance(250);
    const answerId = (worker().sent.find((command) => command.type === "speak") as { id: string }).id;
    worker().emit({ type: "speech_started", id: answerId, latency_ms: 200 });

    expect(voice.status().last).toEqual({
      audioMs: 1800,
      transcribeMs: 120,
      firstSoundMs: 200,
      sinceListeningEnded: { transcriptMs: 300, firstTextMs: 400, firstSoundMs: 1350 },
    });
    expect(logged).toContain("Spoken turn: transcript after 300 ms, first text after 400 ms, first sound after 1350 ms.");
    expect(logged.join("\n")).not.toMatch(/sentence|something/i); // durations only

    // Later sentences of the same answer do not move the figure.
    advance(5_000);
    worker().emit({ type: "speech_started", id: answerId, latency_ms: 90 });
    expect(voice.status().last?.sinceListeningEnded?.firstSoundMs).toBe(1350);
  });

  it("after the wake word, counts from the end of speech the worker heard", async () => {
    const { voice, worker, answered, advance } = await setup();
    worker().emit({ type: "wake_detected", score: 0.9 });
    worker().emit({ type: "state", state: "listening" });
    advance(3_000);
    worker().emit({ type: "state", state: "transcribing" }); // no button: the worker ended listening by itself
    advance(180);
    worker().emit(heard("What is due this week?"));
    await answered();
    expect(voice.status().last?.sinceListeningEnded).toEqual({ transcriptMs: 180, firstTextMs: 180, firstSoundMs: null });

    // A capture that was thrown away leaves no clock running for the next exchange.
    voice.listenStart();
    voice.listenStop();
    voice.listenCancel();
    advance(60_000);
    worker().emit(heard("What is due this week?"));
    await answered();
    expect(voice.status().last?.sinceListeningEnded).toBeNull();
  });

  it("starts speaking each sentence as soon as the model has written it", async () => {
    const { worker, answered } = await setup([new StreamingProvider(["First sentence here. Sec", "ond sentence follows. And a tail"])]);
    worker().emit(heard("Tell me something"));
    await answered();
    expect(worker().spoken()).toEqual(["First sentence here.", "Second sentence follows.", "And a tail"]); // and nothing twice
  });

  it("keeps a spoken conversation going, and starts a new one after a long pause", async () => {
    const { instance, worker, answered, advance } = await setup();
    const count = () => (instance.db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;
    worker().emit(heard("What is due?"));
    await answered();
    worker().sent.length = 0;
    advance(60_000);
    worker().emit(heard("And what is late?"));
    await answered();
    expect(count()).toBe(1);
    worker().sent.length = 0;
    advance(11 * 60_000);
    worker().emit(heard("What is due?"));
    await answered();
    expect(count()).toBe(2);
  });

  it("ignores silence and does not answer its own voice", async () => {
    const { instance, worker, answered, advance } = await setup();
    const turns = () => (instance.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'user'").get() as { n: number }).n;
    worker().emit(heard("   "));
    expect(turns()).toBe(0);

    worker().emit(heard("What is due?"));
    await answered();
    const said = worker().spoken().join(" ");
    worker().emit({ type: "speech_finished", id: "x", interrupted: false });
    // Two seconds later the wake word fires and the "request" is HELIOS's own sentence, heard from the speakers.
    advance(2_000);
    worker().emit({ type: "wake_detected", score: 0.8 });
    worker().emit(heard(said));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(turns()).toBe(1);

    expect(isOwnVoice("nothing is open right now", "Nothing is open right now. 0 open, 0 late.")).toBe(true);
    expect(isOwnVoice("what is due this week", "Nothing is open right now.")).toBe(false);
  });

  it("gives a spoken request the same limits as a typed one", async () => {
    const { instance, worker, answered } = await setup();
    worker().emit(heard("Add a task to call the dentist"));
    await answered();
    // Asked for by voice, still waiting for a yes: nothing was added.
    expect(instance.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(instance.db.prepare("SELECT status, tier FROM approvals").get()).toEqual({ status: "pending", tier: 1 });
    expect(worker().spoken().join(" ")).toContain("Confirm on screen");
  });
});

describe("controlling the worker", () => {
  it("passes push-to-talk and stop on, and says so when voice is down", async () => {
    const { voice, worker } = await setup();
    worker().sent.length = 0;
    voice.listenStart();
    voice.listenStop();
    voice.stopSpeaking();
    voice.say("Testing the voice.");
    expect(worker().sent.map((command) => command.type)).toEqual(["listen_start", "listen_stop", "stop_speaking", "speak", "speak_end"]);
    worker().alive = false;
    expect(() => voice.listenStart()).toThrow(/not running/);
  });

  it("starts the worker without the cloud key", () => {
    // The worker hears and speaks; it never calls a cloud model.
    const env = workerEnv({ PATH: "/usr/bin", HOMEBASE_PORT: "7127", ANTHROPIC_API_KEY: "test-placeholder", Anthropic_Auth_Token: "test-placeholder" }, "/data/models");
    expect(env).toEqual({ PATH: "/usr/bin", HOMEBASE_PORT: "7127", HOMEBASE_MODELS_DIR: "/data/models" });
    // A models folder that was chosen by hand is kept.
    expect(workerEnv({ HOMEBASE_MODELS_DIR: "/elsewhere" }, "/data/models").HOMEBASE_MODELS_DIR).toBe("/elsewhere");
  });

  it("shows hearing and speaking on screen ahead of thinking", async () => {
    const { worker, states, answered } = await setup();
    worker().emit({ type: "state", state: "listening" });
    worker().emit({ type: "state", state: "transcribing" });
    worker().emit(heard("What is due?"));
    worker().emit({ type: "state", state: "idle" });
    await answered();
    worker().emit({ type: "state", state: "speaking" });
    worker().emit({ type: "state", state: "idle" });
    expect(states.filter((state, index) => state !== states[index - 1])).toEqual(["listening", "transcribing", "thinking", "acting", "thinking", "idle", "speaking", "idle"]);
  });
});

describe("when the worker fails", () => {
  it("is started again with growing pauses, then left off, and the core keeps answering", async () => {
    const { voice, worker, workers, scheduled, helios, states } = await setup();
    worker().crash();
    expect(voice.status()).toMatchObject({ worker: "restarting", restarts: 1 });
    expect(scheduled.at(-1)?.ms).toBe(1_000);

    // It keeps dying straight away: the pauses grow, and after five tries it is left off.
    for (const expected of [2_000, 5_000, 15_000, 30_000]) {
      scheduled.at(-1)?.work();
      worker().crash();
      expect(scheduled.at(-1)?.ms).toBe(expected);
    }
    scheduled.at(-1)?.work();
    worker().crash();
    expect(voice.status()).toMatchObject({ worker: "failed", lastError: { code: "worker_failed" } });
    expect(states).toContain("error");

    // The core is untouched: a typed message is answered as always.
    const turn = await helios.handleMessage("What is due?");
    expect(turn.messages.at(-1)?.role).toBe("assistant");

    // And voice can be brought back by hand.
    const before = workers.length;
    voice.restart();
    expect(workers.length).toBe(before + 1);
    expect(worker().alive).toBe(true);
  });

  it("answers aloud when a spoken request cannot be handled, and logs none of the words", async () => {
    const model = new StreamingProvider(["never used"]);
    model.failWith = new Error("failed while sending: my private question");
    const { worker, answered, logged } = await setup([model]);
    worker().emit(heard("my private question"));
    await answered();
    expect(worker().spoken()).toEqual(["The model did not answer. Try again in a moment."]);
    worker().emit({ type: "error", code: "mic_unavailable", message: "PortAudioError" });
    expect(logged.join("\n")).toContain("mic_unavailable");
    expect(logged.join("\n")).not.toContain("private question");
  });
});

describe("the voice routes", () => {
  it("need a login like everything else, and reach the worker", async () => {
    const instance = track(await openInstance({ dataDir: tempDir() }));
    instance.config.voice.enabled = true;
    const workers: FakeWorker[] = [];
    const { app, voice } = await buildServer({
      instance,
      log: silentLogger,
      voiceTransport: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const headers = { host: "localhost:7117", origin: "http://localhost:7117" };
    expect((await app.inject({ method: "POST", url: "/api/voice/listen", headers, payload: { action: "start" } })).statusCode).toBe(401);

    const cookie = `${SESSION_COOKIE}=${createSession(instance.db).token}`;
    const authed = { ...headers, cookie };
    expect((await app.inject({ method: "POST", url: "/api/voice/listen", headers: authed, payload: { action: "start" } })).statusCode).toBe(200);
    expect(workers[0]?.sent.at(-1)).toEqual({ type: "listen_start" });
    expect((await app.inject({ method: "POST", url: "/api/voice/listen", headers: authed, payload: { action: "explode" } })).statusCode).toBe(400);

    // Settings are validated, saved, and sent to the worker.
    const saved = await app.inject({ method: "PUT", url: "/api/voice/settings", headers: authed, payload: { voiceName: "am_adam", speed: 1.1, wakeEnabled: true, wakeThreshold: 0.7 } });
    expect(saved.statusCode).toBe(200);
    expect(workers[0]?.sent.at(-1)).toMatchObject({ type: "configure", config: { voice: "am_adam", speed: 1.1, wake_enabled: true, wake_threshold: 0.7 } });
    expect((await app.inject({ method: "PUT", url: "/api/voice/settings", headers: authed, payload: { speed: 9 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/voice/status", headers: authed })).json()).toMatchObject({ enabled: true, wakeEnabled: true });

    await app.close();
    expect(workers[0]?.alive).toBe(false); // the worker is stopped with the core
    expect(voice).not.toBeNull();
    instance.close();
  });
});

describe("asking for Claude by voice", () => {
  /** A cloud model that exists only in the test. It counts how often it was asked. */
  class SpokenClaude implements ModelProvider {
    readonly id = "claude-strong";
    readonly role = "strong" as const;
    readonly location = "cloud" as const;
    readonly model = "cloud-model";
    asked = 0;
    failWith: Error | null = null;
    async available() {
      return true;
    }
    async chat(request: ChatRequest): Promise<ChatResponse> {
      this.asked++;
      if (this.failWith) throw this.failWith;
      request.onText?.("Claude says two things are due. ");
      return { text: "Claude says two things are due.", toolCalls: [], stop: "end", usage: { inputTokens: 1, outputTokens: 1 }, model: this.model };
    }
  }
  const localVoice = () => new StreamingProvider(["The local model ", "says one thing is due."]);

  it("uses Claude for a spoken request that asks for it, and for no other", async () => {
    const claude = new SpokenClaude();
    const { instance, worker, answered } = await setup([localVoice(), claude]);
    instance.config.ai.cloud.allowed = true;

    worker().emit(heard("Helios, ask Claude what is due this week."));
    await answered();
    expect(claude.asked).toBe(1);
    expect(worker().spoken()).toEqual(["Claude says two things are due."]);

    // A mention in passing, and then an ordinary follow-up in the same spoken conversation: both stay on this machine.
    for (const said of ["I was talking about Claude yesterday. What is due this week?", "And what is late?"]) {
      worker().sent.length = 0;
      worker().emit(heard(said));
      await answered();
      expect(worker().spoken(), said).toEqual(["The local model says one thing is due."]);
    }
    expect(claude.asked).toBe(1);
  });

  it("says that Claude is switched off before the local model's answer, and says it once", async () => {
    const claude = new SpokenClaude();
    const { worker, answered } = await setup([localVoice(), claude]); // cloud models are off
    worker().emit(heard("Use Claude for this question. What is due this week?"));
    await answered();
    expect(claude.asked).toBe(0);
    expect(worker().spoken()).toEqual([
      "Claude is switched off on this machine, so it was not asked.",
      "You can turn cloud models on from the main screen.",
      "The answer below is from the model on this machine.",
      "The local model says one thing is due.",
    ]);
  });

  it("says that a spoken request which did not come first was not taken as one, before the local model's answer", async () => {
    const claude = new SpokenClaude();
    const { instance, worker, answered } = await setup([localVoice(), claude]);
    instance.config.ai.cloud.allowed = true;

    // The question first and the request after it: only the beginning of what was said can ask for Claude.
    worker().emit(heard("What is due this week? Ask Claude."));
    await answered();
    expect(claude.asked).toBe(0);
    expect(worker().spoken()).toEqual([
      "I did not take that as a request for Claude, so the answer below is from this machine.",
      'To ask Claude, begin your message with "Ask Claude".',
      "The local model says one thing is due.",
    ]);
  });

  it("says that Claude failed, and that the answer is not Claude's, before the local model's answer", async () => {
    const claude = new SpokenClaude();
    claude.failWith = new ProviderError("network", "Anthropic could not be reached. Check the internet connection.");
    const { instance, worker, answered } = await setup([localVoice(), claude]);
    instance.config.ai.cloud.allowed = true;

    worker().emit(heard("Ask Claude what is due this week."));
    await answered();
    expect(claude.asked).toBe(1);
    expect(worker().spoken()).toEqual([
      "cloud-model could not answer.",
      "Anthropic could not be reached.",
      "Check the internet connection.",
      "The answer below is from the model on this machine, not from Claude.",
      "The local model says one thing is due.",
    ]);
  });
});
