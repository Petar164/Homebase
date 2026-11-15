// The messages the core exchanges with the voice worker (apps/voice), one
// JSON object per line. The Python side documents the same list in
// helios_voice/protocol.py; the two must stay in step.

export type AudioDevice = { id: number; name: string; default: boolean };

export type VoiceCommand =
  | { type: "configure"; config: Record<string, unknown> }
  | { type: "listen_start" }
  | { type: "listen_stop" }
  | { type: "listen_cancel" }
  | { type: "speak"; id: string; text: string }
  | { type: "speak_end"; id: string }
  | { type: "stop_speaking" }
  | { type: "devices" }
  | { type: "ping" }
  | { type: "shutdown" };

export type VoiceEvent =
  | { type: "ready"; pid: number; wake_available: boolean; vad_available: boolean }
  | { type: "state"; state: "idle" | "listening" | "transcribing" | "speaking" }
  | { type: "partial"; text: string }
  | { type: "transcript"; text: string; audio_ms: number; decode_ms: number }
  | { type: "speech_started"; id: string; latency_ms: number }
  | { type: "speech_finished"; id: string; interrupted: boolean }
  | { type: "wake_detected"; score: number }
  | { type: "devices"; inputs: AudioDevice[]; outputs: AudioDevice[] }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

/**
 * A running voice worker, as the core sees it. The real one is a child
 * process; tests use one that lives in memory.
 */
export interface VoiceTransport {
  start(): void;
  /** False when the worker is not running; the command is then dropped. */
  send(command: VoiceCommand): boolean;
  stop(): void;
  onEvent(listener: (event: VoiceEvent) => void): void;
  /** Called once each time the worker stops, expected or not. */
  onExit(listener: () => void): void;
}
