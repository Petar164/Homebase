"""Lets you hear HELIOS's voice before choosing it.

    uv run python -m helios_voice.audition                 writes WAV files, plays nothing
    uv run python -m helios_voice.audition --play          also plays them, one after another
    uv run python -m helios_voice.audition --voices am_michael,am_adam --speed 1.1

Each voice says the same sentences, so they can be compared like for like.
The files go to the `voice-audition` folder next to the models folder
unless `--out` says otherwise.
"""

from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np

from .engines import KokoroTts, models_dir

SENTENCES = {
    "greeting": "Good evening. Two things are due this week, and one of them is already late.",
    "pushback": "I would not do that yet. The numbers you gave me do not support raising prices this month.",
    "detail": "On Friday the twentieth at three, you have the dentist. Your savings stand at one thousand two hundred euros.",
    "calm": "Understood. I will keep that in mind, and I will remind you tomorrow morning.",
}


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    with wave.open(str(path), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(rate)
        file.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes())


def main() -> None:
    parser = argparse.ArgumentParser(prog="helios_voice.audition")
    parser.add_argument("--voices", default="", help="comma-separated; default: every male American voice")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--model", default="int8", choices=["int8", "full"])
    parser.add_argument("--out", default="")
    parser.add_argument("--play", action="store_true")
    parser.add_argument("--gain", type=float, default=1.0, help="playback volume, 0 to 1")
    args = parser.parse_args()

    tts = KokoroTts(args.model)
    voices = [v for v in args.voices.split(",") if v] or [v for v in tts.voices() if v.startswith("am_")]
    out = Path(args.out) if args.out else models_dir().parent / "voice-audition"
    out.mkdir(parents=True, exist_ok=True)
    for voice in voices:
        for name, sentence in SENTENCES.items():
            samples, rate = tts.synthesize(sentence, voice, args.speed)
            path = out / f"{voice}-{name}.wav"
            write_wav(path, samples, rate)
            print(f"{path.name}  {len(samples) / rate:.1f} s")
            if args.play:
                from .audio import SoundDeviceBackend

                SoundDeviceBackend().play(samples, rate, None, lambda: False, args.gain)
    print(f"\n{len(voices) * len(SENTENCES)} files in {out}")


if __name__ == "__main__":
    main()
