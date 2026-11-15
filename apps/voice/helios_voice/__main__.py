"""Starts the voice worker. The core runs:  python -m helios_voice

    --fake      scripted engines and in-memory audio: for tests, needs no models
    --stt NAME  parakeet-unified (default) or parakeet-tdt-v2
    --tts NAME  int8 (default) or full
    --wake FILE the wake model file in the models folder
"""

from __future__ import annotations

import argparse
import sys

from .protocol import Channel, log, take_over_stdout
from .worker import Worker


def build(args: argparse.Namespace, channel: Channel) -> Worker:
    if args.fake:
        from .audio import MockAudioBackend
        from .engines import FakeStt, FakeTts, FakeWake

        audio = MockAudioBackend()
        audio.auto_feed_seconds = 1.0  # so a press of the talk button produces the scripted sentence
        audio.play_seconds = 0.8  # and an answer takes a moment to "say"
        return Worker(channel, audio, FakeStt, FakeTts, None, FakeWake)

    from .audio import SoundDeviceBackend
    from .engines import KokoroTts, OpenWakeWord, ParakeetStt, SileroVad

    def stt():
        # The preferred recogniser, or the fallback if it will not load.
        try:
            return ParakeetStt(args.stt)
        except Exception as error:
            if args.stt == "parakeet-tdt-v2":
                raise
            log(f"{args.stt} did not load ({type(error).__name__}); using parakeet-tdt-v2")
            return ParakeetStt("parakeet-tdt-v2")

    return Worker(channel, SoundDeviceBackend(), stt, lambda: KokoroTts(args.tts), SileroVad, lambda: OpenWakeWord(args.wake))


def main() -> None:
    parser = argparse.ArgumentParser(prog="helios_voice")
    parser.add_argument("--fake", action="store_true")
    parser.add_argument("--stt", default="parakeet-unified")
    parser.add_argument("--tts", default="int8")
    parser.add_argument("--wake", default="hey_jarvis_v0.1.onnx")
    args = parser.parse_args()

    channel = Channel(take_over_stdout())
    worker = build(args, channel)
    log("started (fake engines)" if args.fake else f"started (stt {args.stt}, tts kokoro-{args.tts})")
    worker.run(sys.stdin)
    log("stopped")


if __name__ == "__main__":
    main()
