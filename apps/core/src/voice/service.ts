import type { Helios } from "../ai/helios.ts";
import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import type { EventBus } from "../events.ts";
import { type Logger, newId } from "../util.ts";
import type { AudioDevice, VoiceCommand, VoiceEvent, VoiceTransport } from "./protocol.ts";

// The core's side of voice. It starts the voice worker, restarts it when
// it dies, turns what was heard into a normal conversation turn, and has
// the answer spoken sentence by sentence while it is still being written.
//
// The worker only hears and speaks. Everything that decides something (the
// model, the tools, permissions, the cloud gate) is the same path a typed
// message takes. A spoken request gets no extra rights: the wake word and
// the voice are not authentication.

export type VoiceStatus = {
  enabled: boolean;
  /** "running", "starting", "restarting" after a crash, or "failed" when it gave up. */
  worker: "off" | "starting" | "running" | "restarting" | "failed";
  state: "idle" | "listening" | "transcribing" | "speaking";
  wakeAvailable: boolean;
  wakeEnabled: boolean;
  devices: { inputs: AudioDevice[]; outputs: AudioDevice[] };
  /** The kind of the last problem, never what was said. */
  lastError: { code: string; message: string; at: string } | null;
  restarts: number;
  /** Timings of the last exchange, in milliseconds. */
  last: {
    audioMs: number;
    transcribeMs: number;
    /** The worker's own figure: from the first sentence reaching it to that sentence being ready to play. */
    firstSoundMs: number | null;
    /**
     * The whole exchange on the core's clock, counted from the moment
     * listening ended: the talk button was released, or the worker heard
     * the end of speech. `firstSoundMs` here is the moment the first
     * sentence was handed to the speakers; the delay of the sound system
     * itself comes on top. Null when nobody was listening first.
     */
    sinceListeningEnded: { transcriptMs: number; firstTextMs: number | null; firstSoundMs: number | null } | null;
  } | null;
};

/** Waits between restarts after a crash, in milliseconds. After the last one the service gives up. */
const RESTART_DELAYS = [1_000, 2_000, 5_000, 15_000, 30_000];
/** A worker that stayed up this long is considered healthy again. */
const HEALTHY_AFTER_MS = 60_000;
/** A spoken conversation continues if the last exchange was this recent. */
const CONTINUE_WITHIN_MS = 10 * 60_000;
/** After HELIOS finishes speaking, a wake-word transcript this soon is checked against what it just said. */
const ECHO_WINDOW_MS = 4_000;

const SENTENCE = /^([\s\S]+?[.!?])(\s+)/;

/** The words of a text, for comparing what was heard with what was just said. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
}

/** True when most of what was heard is what HELIOS itself just said. */
export function isOwnVoice(heard: string, spoken: string): boolean {
  const heardWords = wordsOf(heard);
  if (heardWords.length < 2) return false;
  const spokenWords = new Set(wordsOf(spoken));
  return heardWords.filter((word) => spokenWords.has(word)).length / heardWords.length >= 0.8;
}

export class VoiceService {
  private readonly helios: Helios;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly settings: Config["voice"];
  private readonly createTransport: () => VoiceTransport;
  private readonly schedule: (work: () => void, ms: number) => void;
  private readonly now: () => number;

  private transport: VoiceTransport | null = null;
  private worker: VoiceStatus["worker"] = "off";
  private state: VoiceStatus["state"] = "idle";
  private wakeAvailable = false;
  private devices: VoiceStatus["devices"] = { inputs: [], outputs: [] };
  private lastError: VoiceStatus["lastError"] = null;
  private last: VoiceStatus["last"] = null;
  private restarts = 0;
  private failuresInARow = 0;
  private startedAt = 0;
  private stopped = false;

  private conversation: { id: string; at: number } | null = null;
  private trigger: "talk" | "wake" = "talk";
  /** The answer being spoken: its id, the text not yet sent as a sentence, and everything sent. */
  private answer: { id: string; pending: string; spoken: string } | null = null;
  private lastSpoken: { text: string; at: number } = { text: "", at: 0 };
  /** When listening last ended, until the transcript for it arrives. */
  private listeningEndedAt: number | null = null;
  /** The exchange being timed: when its listening ended, and the answer that belongs to it. */
  private timed: { endedAt: number; answerId: string | null } | null = null;

  constructor(deps: {
    helios: Helios;
    bus: EventBus;
    log: Logger;
    settings: Config["voice"];
    createTransport: () => VoiceTransport;
    schedule?: (work: () => void, ms: number) => void;
    now?: () => number;
  }) {
    this.helios = deps.helios;
    this.bus = deps.bus;
    this.log = deps.log;
    this.settings = deps.settings;
    this.createTransport = deps.createTransport;
    this.schedule = deps.schedule ?? ((work, ms) => void setTimeout(work, ms).unref());
    this.now = deps.now ?? Date.now;
    // Text arrives from the model in pieces; each finished sentence is
    // handed to the worker at once, so speech starts before the answer is complete.
    this.bus.subscribe((event) => {
      if (event.type === "delta" && this.answer) this.feed(event.text);
    });
  }

  // ---------- life cycle ----------

  start(): void {
    this.stopped = false;
    this.launch("starting");
  }

  private launch(as: "starting" | "restarting"): void {
    if (this.stopped) return;
    this.worker = as;
    this.startedAt = this.now();
    const transport = this.createTransport();
    this.transport = transport;
    transport.onEvent((event) => this.onEvent(event));
    transport.onExit(() => this.onExit(transport));
    try {
      transport.start();
    } catch {
      this.onExit(transport);
    }
  }

  private onExit(transport: VoiceTransport): void {
    if (this.transport !== transport) return;
    this.transport = null;
    this.setState("idle");
    this.answer = null;
    if (this.stopped) {
      this.worker = "off";
      return;
    }
    // The core carries on. The worker is started again, with growing pauses,
    // and after repeated failures it is left off until someone restarts it.
    this.failuresInARow = this.now() - this.startedAt > HEALTHY_AFTER_MS ? 1 : this.failuresInARow + 1;
    const delay = RESTART_DELAYS[this.failuresInARow - 1];
    if (delay === undefined) {
      this.worker = "failed";
      this.fail("worker_failed", "the voice worker keeps stopping");
      this.log.error("The voice worker keeps stopping. Voice is off until it is restarted.");
      return;
    }
    this.worker = "restarting";
    this.restarts++;
    this.log.warn(`The voice worker stopped. Starting it again in ${delay / 1000} s.`);
    this.schedule(() => this.launch("restarting"), delay);
  }

  /** Starts the worker again after it gave up, or to apply new settings. */
  restart(): void {
    this.failuresInARow = 0;
    const running = this.transport;
    if (running) running.stop();
    else this.launch("starting");
  }

  stop(): void {
    this.stopped = true;
    this.transport?.stop();
  }

  // ---------- what the owner can do ----------

  private send(command: VoiceCommand): void {
    if (!this.transport?.send(command)) throw new AppError(503, "Voice is not running right now.");
  }

  listenStart(): void {
    this.trigger = "talk";
    this.listeningEndedAt = null;
    this.send({ type: "listen_start" }); // the worker stops any speech first
  }

  listenStop(): void {
    this.listeningEndedAt = this.now(); // the clock for "how long until HELIOS answers" starts here
    this.send({ type: "listen_stop" });
  }

  listenCancel(): void {
    this.listeningEndedAt = null;
    this.send({ type: "listen_cancel" });
  }

  stopSpeaking(): void {
    this.answer = null;
    this.send({ type: "stop_speaking" });
  }

  /** Says a text in HELIOS's voice: used to try out a voice. */
  say(text: string): void {
    const id = newId();
    this.send({ type: "speak", id, text });
    this.send({ type: "speak_end", id });
  }

  refreshDevices(): void {
    this.send({ type: "devices" });
  }

  /** Sends the current settings to the worker. */
  configure(): void {
    const { settings } = this;
    this.transport?.send({
      type: "configure",
      config: {
        input_device: settings.inputDevice,
        output_device: settings.outputDevice,
        voice: settings.voiceName,
        speed: settings.speed,
        gain: settings.gain,
        guard_ms: settings.guardMs,
        wake_enabled: settings.wake.enabled,
        wake_threshold: settings.wake.threshold,
      },
    });
  }

  status(): VoiceStatus {
    return {
      enabled: this.settings.enabled,
      worker: this.worker,
      state: this.state,
      wakeAvailable: this.wakeAvailable,
      wakeEnabled: this.settings.wake.enabled,
      devices: this.devices,
      lastError: this.lastError,
      restarts: this.restarts,
      last: this.last,
    };
  }

  // ---------- what the worker reports ----------

  private setState(state: VoiceStatus["state"]): void {
    this.state = state;
    this.helios.setVoiceState(state);
  }

  private fail(code: string, message: string): void {
    this.lastError = { code, message, at: new Date(this.now()).toISOString() };
    // Shown on screen for a moment, then cleared.
    this.helios.setVoiceState("error");
    this.schedule(() => this.helios.setVoiceState(this.state), 4_000);
  }

  private onEvent(event: VoiceEvent): void {
    switch (event.type) {
      case "ready":
        this.worker = "running";
        this.wakeAvailable = event.wake_available;
        this.configure();
        this.transport?.send({ type: "devices" });
        break;
      case "state":
        // After the wake word the worker ends listening by itself, with no
        // button released: its change to "transcribing" is the moment then.
        if (event.state === "transcribing") this.listeningEndedAt ??= this.now();
        this.setState(event.state);
        break;
      case "devices":
        this.devices = { inputs: event.inputs, outputs: event.outputs };
        break;
      case "wake_detected":
        this.trigger = "wake";
        break;
      case "transcript": {
        const endedAt = this.listeningEndedAt;
        this.listeningEndedAt = null;
        this.timed = endedAt === null ? null : { endedAt, answerId: null };
        this.last = {
          audioMs: event.audio_ms,
          transcribeMs: event.decode_ms,
          firstSoundMs: null,
          sinceListeningEnded: endedAt === null ? null : { transcriptMs: this.now() - endedAt, firstTextMs: null, firstSoundMs: null },
        };
        void this.onTranscript(event.text);
        break;
      }
      case "speech_started": {
        if (this.last) this.last.firstSoundMs = event.latency_ms;
        const timings = this.last?.sinceListeningEnded;
        if (timings && this.timed && event.id === this.timed.answerId && timings.firstSoundMs === null) {
          timings.firstSoundMs = this.now() - this.timed.endedAt;
          // Durations only, never what was said.
          this.log.info(`Spoken turn: transcript after ${timings.transcriptMs} ms, first text after ${timings.firstTextMs ?? "?"} ms, first sound after ${timings.firstSoundMs} ms.`);
        }
        break;
      }
      case "speech_finished":
        this.lastSpoken.at = this.now();
        break;
      case "error":
        // Only the kind of problem is kept and logged.
        this.log.warn(`Voice worker reported ${event.code} (${String(event.message).match(/^[A-Za-z_][A-Za-z0-9_]{0,80}$/)?.[0] ?? "details hidden"}).`);
        this.fail(event.code, event.message);
        break;
      default:
        break;
    }
  }

  private async onTranscript(text: string): Promise<void> {
    const heard = text.trim();
    if (!heard) return;
    // Woken by the wake word right after speaking, and hearing its own
    // words: that is the room playing HELIOS back to itself, not a request.
    if (this.trigger === "wake" && this.now() - this.lastSpoken.at < ECHO_WINDOW_MS && isOwnVoice(heard, this.lastSpoken.text)) {
      this.log.info("Ignored a transcript that matched what HELIOS had just said.");
      return;
    }

    const speak = this.settings.speakReplies;
    const answer = { id: newId(), pending: "", spoken: "" };
    if (speak) this.answer = answer;
    if (speak && this.timed) this.timed.answerId = answer.id;
    try {
      const continuing = this.conversation && this.now() - this.conversation.at < CONTINUE_WITHIN_MS ? this.conversation.id : undefined;
      const turn = await this.helios.handleMessage(heard, { conversationId: continuing, channel: "voice" });
      this.conversation = { id: turn.conversationId, at: this.now() };
      if (!speak || this.answer !== answer) return; // speaking is off, or it was interrupted
      this.flush();
      // Notes from the core (an approval is needed, the budget is used up)
      // are not streamed as answer text, so they are spoken here. So is an
      // answer from a model that did not stream.
      for (const message of turn.messages) {
        if (message.role === "user") continue;
        if (message.role === "assistant" && answer.spoken.includes(message.text.trim().slice(0, 40))) continue;
        this.speakSentence(message.text);
      }
    } catch (error) {
      // A spoken request that cannot be handled is answered, not dropped.
      if (speak && this.answer === answer) this.speakSentence(error instanceof AppError ? error.message : "Something went wrong while answering.");
      if (!(error instanceof AppError)) this.log.error(`A spoken request failed (${(error as Error).name}).`);
    } finally {
      if (this.answer === answer) {
        this.transport?.send({ type: "speak_end", id: answer.id });
        this.lastSpoken = { text: answer.spoken, at: this.now() };
        this.answer = null;
      }
    }
  }

  /** Takes a piece of answer text and sends every sentence that is now complete. */
  private feed(text: string): void {
    if (!this.answer) return;
    this.answer.pending += text;
    for (;;) {
      const match = SENTENCE.exec(this.answer.pending);
      // Very short pieces ("e.g.", "No.") wait for more text, so abbreviations are not cut apart.
      if (!match?.[1] || match[1].trim().length < 12) break;
      this.answer.pending = this.answer.pending.slice(match[0].length);
      this.speakSentence(match[1]);
    }
  }

  private flush(): void {
    if (!this.answer) return;
    const rest = this.answer.pending.trim();
    this.answer.pending = "";
    if (rest) this.speakSentence(rest);
  }

  private speakSentence(text: string): void {
    const sentence = text.trim();
    if (!this.answer || !sentence) return;
    const timings = this.last?.sinceListeningEnded;
    if (timings && timings.firstTextMs === null && this.timed?.answerId === this.answer.id) timings.firstTextMs = this.now() - this.timed.endedAt;
    this.answer.spoken += `${sentence} `;
    this.transport?.send({ type: "speak", id: this.answer.id, text: sentence });
  }
}
