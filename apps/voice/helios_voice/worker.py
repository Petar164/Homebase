"""The voice worker: what happens between a command from the core and
sound going in or out.

Three rules shape this file:

1. The worker decides nothing. It hears, transcribes and speaks what it is
   told to. What to do with the words is the core's business.
2. HELIOS never answers its own voice. While it is speaking, and for a
   short guard time afterwards, the microphone is ignored for the wake
   word. Pressing push-to-talk stops the speech first.
3. A failure is reported and survived. A missing microphone, a broken
   speaker or a model that will not load becomes an `error` event; the
   worker keeps running and the next command is tried afresh.

Models are loaded the first time they are needed, not at start.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from dataclasses import dataclass
from typing import Callable, TextIO

import numpy as np

from .audio import SAMPLE_RATE, AudioBackend, AudioUnavailable
from .engines import SttEngine, TtsEngine, WakeEngine, split_sentences
from .protocol import Channel, log


@dataclass
class Settings:
    input_device: str | int | None = None
    output_device: str | int | None = None
    voice: str = "am_michael"
    speed: float = 1.0
    #: Playback volume, from 0 to 1.
    gain: float = 1.0
    wake_enabled: bool = False
    #: How sure the wake model has to be, from 0 to 1. Higher means fewer false alarms.
    wake_threshold: float = 0.5
    #: After HELIOS stops speaking, the microphone is ignored for this long,
    #: so the tail of its own voice in the room cannot wake it.
    guard_ms: int = 500
    #: A capture is cut off after this many seconds.
    max_listen_s: float = 30.0
    #: After the wake word, give up if nobody speaks within this time.
    wake_timeout_s: float = 6.0
    trim_silence: bool = True

    def update(self, values: dict) -> None:
        for key, value in values.items():
            if hasattr(self, key):
                setattr(self, key, value)


class Worker:
    def __init__(
        self,
        channel: Channel,
        audio: AudioBackend,
        make_stt: Callable[[], SttEngine],
        make_tts: Callable[[], TtsEngine],
        make_vad: Callable[[], object] | None = None,
        make_wake: Callable[[], WakeEngine] | None = None,
    ) -> None:
        self.channel = channel
        self.audio = audio
        self.settings = Settings()
        self._make = {"stt": make_stt, "tts": make_tts, "vad": make_vad, "wake": make_wake}
        self._engines: dict[str, object] = {}
        self._lock = threading.RLock()
        self._state = "idle"
        # listening
        self._capturing = False
        self._endpointing = False  # True when the wake word started the capture
        self._heard_speech = False
        self._capture_started = 0.0
        self._buffer: list[np.ndarray] = []
        self._transcribing = 0
        # speaking
        self._speech: queue.Queue = queue.Queue()
        self._generation = 0  # goes up every time speech is cancelled
        self._open: dict[str, float] = {}  # answers being spoken: id -> when their first text arrived
        self._started: set[str] = set()
        self._speaking = False
        self._guard_until = 0.0
        self._closing = False
        self._speech_thread = threading.Thread(target=self._speech_loop, name="speech", daemon=True)
        self._speech_thread.start()

    # ---------- helpers ----------

    def _engine(self, kind: str):
        """The model for `kind`, loaded on first use."""
        with self._lock:
            if kind not in self._engines:
                factory = self._make.get(kind)
                if factory is None:
                    return None
                started = time.perf_counter()
                self._engines[kind] = factory()
                log(f"loaded {kind} model in {int((time.perf_counter() - started) * 1000)} ms")
            return self._engines[kind]

    def _refresh_state(self) -> None:
        with self._lock:
            state = "listening" if self._capturing else "transcribing" if self._transcribing else "speaking" if self._speaking else "idle"
            changed = state != self._state
            self._state = state
        if changed:
            self.channel.send("state", state=state)

    def _error(self, code: str, error: BaseException | str) -> None:
        # Only the kind of error is passed on: an error message can quote input.
        detail = error if isinstance(error, str) else type(error).__name__ if not isinstance(error, AudioUnavailable) else str(error)
        log(f"error {code}: {detail}")
        self.channel.send("error", code=code, message=detail)

    def _want_input(self) -> bool:
        return self._capturing or (self.settings.wake_enabled and self._make.get("wake") is not None)

    def _sync_input(self) -> None:
        """Opens or closes the microphone so it is only open when needed."""
        if self._want_input():
            if not getattr(self, "_input_open", False):
                self.audio.open_input(self.settings.input_device, self._on_chunk)
                self._input_open = True
        elif getattr(self, "_input_open", False):
            self.audio.close_input()
            self._input_open = False

    # ---------- commands ----------

    def handle(self, command: dict) -> None:
        kind = command.get("type")
        handler = getattr(self, f"_on_{kind}", None) if isinstance(kind, str) else None
        if handler is None:
            self._error("bad_command", "unknown command")
            return
        try:
            handler(command)
        except AudioUnavailable as error:
            self._error("audio_unavailable", error)
        except Exception as error:  # the worker must outlive any single command
            self._error("internal", error)

    def _on_ping(self, _command: dict) -> None:
        self.channel.send("pong")

    def _on_devices(self, _command: dict) -> None:
        self.channel.send("devices", **self.audio.devices())

    def _on_configure(self, command: dict) -> None:
        self.settings.update(command.get("config") or {})
        if self.settings.wake_enabled:
            try:
                if self._engine("wake") is None:
                    raise RuntimeError("no wake model")
            except Exception as error:
                self.settings.wake_enabled = False
                self._error("wake_unavailable", error)
        try:
            self._sync_input()
        except AudioUnavailable as error:
            self._input_open = False
            self._error("mic_unavailable", error)

    def _on_listen_start(self, _command: dict) -> None:
        self._stop_speaking()  # never talk over the owner
        self._begin_capture(endpointing=False)

    def _begin_capture(self, endpointing: bool) -> None:
        with self._lock:
            self._buffer = []
            self._capturing = True
            self._endpointing = endpointing
            self._heard_speech = False
            self._capture_started = time.monotonic()
        try:
            self._input_open = False if not getattr(self, "_input_open", False) else self._input_open
            self._sync_input()
        except AudioUnavailable as error:
            with self._lock:
                self._capturing = False
            self._input_open = False
            self._refresh_state()
            self._error("mic_unavailable", error)
            return
        self._refresh_state()

    def _on_listen_stop(self, _command: dict) -> None:
        self._finish_capture()

    def _on_listen_cancel(self, _command: dict) -> None:
        with self._lock:
            self._capturing = False
            self._buffer = []
        self._close_input_quietly()
        self._refresh_state()

    def _on_speak(self, command: dict) -> None:
        uid, text = str(command.get("id", "")), str(command.get("text", ""))
        with self._lock:
            self._open.setdefault(uid, time.monotonic())
            generation = self._generation
        self._speech.put((generation, "say", uid, text))

    def _on_speak_end(self, command: dict) -> None:
        with self._lock:
            generation = self._generation
        self._speech.put((generation, "end", str(command.get("id", "")), ""))

    def _on_stop_speaking(self, _command: dict) -> None:
        self._stop_speaking()

    def _on_shutdown(self, _command: dict) -> None:
        self.close()

    # ---------- listening ----------

    def _close_input_quietly(self) -> None:
        try:
            self._sync_input()
        except AudioUnavailable:
            self._input_open = False

    def _on_chunk(self, chunk: np.ndarray) -> None:
        """Called by the audio device for every 100 ms of microphone sound."""
        finish = cancel = False
        with self._lock:
            if self._capturing:
                self._buffer.append(chunk)
                elapsed = time.monotonic() - self._capture_started
                if elapsed > self.settings.max_listen_s:
                    finish = True
                elif self._endpointing:
                    vad = self._engines.get("vad")
                    if vad is not None:
                        vad.feed(chunk)
                        if vad.speaking():
                            self._heard_speech = True
                        elif self._heard_speech:
                            finish = True  # the speaker stopped
                        elif elapsed > self.settings.wake_timeout_s:
                            cancel = True  # woken, but nobody said anything
            elif not self.settings.wake_enabled or self._speaking or time.monotonic() < self._guard_until:
                return  # rule 2: deaf to the wake word while speaking and just after
        if finish:
            self._finish_capture()
            return
        if cancel:
            self._on_listen_cancel({})
            return
        if self._capturing:
            return
        wake = self._engines.get("wake")
        if wake is None:
            return
        score = wake.score(chunk)
        if score >= self.settings.wake_threshold:
            wake.reset()
            self.channel.send("wake_detected", score=round(float(score), 3))
            vad = self._engine("vad")
            if vad is not None:
                vad.reset()
            self._begin_capture(endpointing=vad is not None)

    def _finish_capture(self) -> None:
        with self._lock:
            if not self._capturing:
                return
            self._capturing = False
            chunks, self._buffer = self._buffer, []
            self._transcribing += 1
        self._close_input_quietly()
        self._refresh_state()
        threading.Thread(target=self._transcribe, args=(chunks,), name="transcribe", daemon=True).start()

    def _transcribe(self, chunks: list[np.ndarray]) -> None:
        try:
            samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            audio_ms = int(len(samples) / SAMPLE_RATE * 1000)
            text, decode_ms = "", 0
            if audio_ms >= 300:
                speech = samples
                if self.settings.trim_silence and self._make.get("vad") is not None:
                    # A separate detector from the one that watches for the end of speech.
                    if "trim" not in self._engines:
                        self._engines["trim"] = self._make["vad"]()
                    speech = self._engines["trim"].trim(samples)
                if len(speech) >= SAMPLE_RATE * 0.2:
                    started = time.perf_counter()
                    text = self._engine("stt").transcribe(speech, SAMPLE_RATE)
                    decode_ms = int((time.perf_counter() - started) * 1000)
            log(f"transcribed {audio_ms} ms of audio in {decode_ms} ms")  # never the words
            self.channel.send("transcript", text=text, audio_ms=audio_ms, decode_ms=decode_ms)
        except Exception as error:
            self._error("stt_failed", error)
            self.channel.send("transcript", text="", audio_ms=0, decode_ms=0)
        finally:
            with self._lock:
                self._transcribing -= 1
            self._refresh_state()

    # ---------- speaking ----------

    def _stop_speaking(self) -> None:
        with self._lock:
            self._generation += 1  # everything queued or playing is now stale
            interrupted = list(self._open)
            self._open.clear()
            self._started.clear()
        for uid in interrupted:
            self.channel.send("speech_finished", id=uid, interrupted=True)

    def _after_speech(self) -> None:
        with self._lock:
            self._speaking = False
            self._guard_until = time.monotonic() + self.settings.guard_ms / 1000
        self._refresh_state()

    def _speech_loop(self) -> None:
        while not self._closing:
            try:
                generation, kind, uid, text = self._speech.get(timeout=2.0)
            except queue.Empty:
                # An answer whose end never arrived must not leave the worker
                # "speaking" (and deaf to the wake word) for ever.
                if self._speaking and self._speech.empty():
                    with self._lock:
                        stale = list(self._open)
                        self._open.clear()
                        self._started.clear()
                    for stale_id in stale:
                        self.channel.send("speech_finished", id=stale_id, interrupted=False)
                    self._after_speech()
                continue
            if kind == "quit":
                return
            if generation != self._generation:
                continue  # cancelled before its turn came
            if kind == "end":
                with self._lock:
                    opened = self._open.pop(uid, None)
                    self._started.discard(uid)
                if opened is not None:
                    self.channel.send("speech_finished", id=uid, interrupted=False)
                if self._speech.empty():
                    self._after_speech()
                continue

            stale = lambda: generation != self._generation  # noqa: E731
            for sentence in split_sentences(text) or ([text] if text.strip() else []):
                if stale():
                    break
                try:
                    samples, rate = self._engine("tts").synthesize(sentence, self.settings.voice, self.settings.speed)
                except Exception as error:
                    self._error("tts_failed", error)
                    break
                if stale():
                    break
                with self._lock:
                    first = uid in self._open and uid not in self._started
                    if first:
                        self._started.add(uid)
                        latency = int((time.monotonic() - self._open[uid]) * 1000)
                    self._speaking = True
                if first:
                    self.channel.send("speech_started", id=uid, latency_ms=latency)
                self._refresh_state()
                try:
                    if self.audio.play(samples, rate, self.settings.output_device, stale, self.settings.gain):
                        break
                except AudioUnavailable as error:
                    self._error("output_unavailable", error)
                    self._stop_speaking()
                    break
            if stale():
                self._after_speech()

    # ---------- life cycle ----------

    def ready(self) -> None:
        self.channel.send("ready", pid=os.getpid(), wake_available=self._make.get("wake") is not None, vad_available=self._make.get("vad") is not None)

    def close(self) -> None:
        if self._closing:
            return
        self._closing = True
        self._stop_speaking()
        with self._lock:
            self._capturing = False
            self.settings.wake_enabled = False
        self._close_input_quietly()
        self._speech.put((self._generation, "quit", "", ""))

    def run(self, commands: TextIO) -> None:
        """Reads commands until the core closes the pipe. If the core
        disappears, so does the worker: nothing listens without it."""
        self.ready()
        for line in commands:
            line = line.strip()
            if not line:
                continue
            try:
                command = json.loads(line)
                if not isinstance(command, dict):
                    raise ValueError
            except ValueError:
                self._error("bad_command", "not a JSON object")
                continue
            self.handle(command)
            if self._closing:
                break
        self.close()
