"""How the voice worker and the core talk: one JSON object per line.

The core starts this worker as a child process, writes commands to its
standard input and reads events from its standard output. Nothing else may
ever be written to standard output, so `take_over_stdout` moves the real
stream out of reach of libraries that print.

Commands (core -> worker)
    configure       settings: devices, voice, speed, wake word, guard time
    listen_start    push-to-talk pressed: start capturing the microphone
    listen_stop     push-to-talk released: transcribe what was captured
    listen_cancel   throw the capture away
    speak           {id, text}: say this; may be sent several times per id
    speak_end       {id}: no more text is coming for this id
    stop_speaking   stop talking now and forget what was queued
    devices         list microphones and speakers
    ping            answer with pong
    shutdown        stop cleanly

Events (worker -> core)
    ready           the worker is up; which engines it will use
    state           idle | listening | transcribing | speaking
    partial         {text}: words so far (only with a streaming recogniser)
    transcript      {text, audio_ms, decode_ms}: what was said
    speech_started  {id, latency_ms}: first sound of an answer
    speech_finished {id, interrupted}
    wake_detected   {score}
    devices         {inputs, outputs}
    error           {code, message}: something failed; the worker goes on
    pong

Privacy rule: what was said and what is spoken travel only in `transcript`,
`partial` and `speak`. They are never written to the log.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from typing import Any, TextIO

STATES = ("idle", "listening", "transcribing", "speaking")


class Channel:
    """Sends events to the core, one line each, safely from several threads."""

    def __init__(self, out: TextIO) -> None:
        self._out = out
        self._lock = threading.Lock()

    def send(self, type_: str, **fields: Any) -> None:
        line = json.dumps({"type": type_, **fields}, separators=(",", ":"), ensure_ascii=False)
        with self._lock:
            self._out.write(line + "\n")
            self._out.flush()


def take_over_stdout() -> TextIO:
    """Returns a private handle on the real standard output and points the
    usual one at standard error, so a library that prints cannot corrupt the
    protocol."""
    private = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return private


def log(message: str) -> None:
    """Writes one line to the log (standard error). Callers pass facts about
    what happened (durations, sizes, device names, error types), never the
    words that were said or spoken."""
    print(f"{time.strftime('%H:%M:%S')} voice: {message}", file=sys.stderr, flush=True)
