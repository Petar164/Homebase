"""The models behind the voice: speech to text, speech detection, text to
speech and the wake word.

Each has a tiny interface, a real implementation and a fake one. The real
ones are loaded lazily (a model is only read into memory the first time it
is needed) and all run on the CPU, so they do not compete with the local
language model for GPU memory.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Protocol

import numpy as np

from .audio import SAMPLE_RATE


def models_dir() -> Path:
    """Where the model files live: outside the repository, in the data folder."""
    if os.environ.get("HOMEBASE_MODELS_DIR"):
        return Path(os.environ["HOMEBASE_MODELS_DIR"])
    if os.environ.get("HOMEBASE_DATA_DIR"):
        return Path(os.environ["HOMEBASE_DATA_DIR"]) / "models"
    home = Path.home()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local")) / "HomeBase" / "models"
    if (home / "Library").exists():
        return home / "Library" / "Application Support" / "HomeBase" / "models"
    return Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share")) / "homebase" / "models"


# The speech recognisers this worker knows, by the name used in the settings.
STT_MODELS = {
    # The preferred model: NVIDIA Parakeet Unified English 0.6B, int8, non-streaming export.
    "parakeet-unified": "sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming",
    # The fallback named in the brief.
    "parakeet-tdt-v2": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
}
TTS_MODELS = {"int8": "kokoro-v1.0.int8.onnx", "full": "kokoro-v1.0.onnx"}


# ---------- speech to text ----------


class SttEngine(Protocol):
    name: str

    def transcribe(self, samples: np.ndarray, rate: int = SAMPLE_RATE) -> str: ...


class ParakeetStt:
    """NVIDIA Parakeet through sherpa-onnx, on the CPU."""

    def __init__(self, model: str = "parakeet-unified", threads: int = 4) -> None:
        import sherpa_onnx

        folder = models_dir() / "stt" / STT_MODELS[model]
        if not (folder / "encoder.int8.onnx").exists():
            raise FileNotFoundError(f"speech model {model} is not installed")
        self.name = model
        self._recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(folder / "encoder.int8.onnx"),
            decoder=str(folder / "decoder.int8.onnx"),
            joiner=str(folder / "joiner.int8.onnx"),
            tokens=str(folder / "tokens.txt"),
            model_type="nemo_transducer",
            num_threads=threads,
        )

    def transcribe(self, samples: np.ndarray, rate: int = SAMPLE_RATE) -> str:
        stream = self._recognizer.create_stream()
        stream.accept_waveform(rate, np.ascontiguousarray(samples, dtype=np.float32))
        self._recognizer.decode_stream(stream)
        return stream.result.text.strip()


class FakeStt:
    name = "fake"

    def __init__(self, text: str = "what is due this week") -> None:
        self.text = text
        self.heard: list[int] = []

    def transcribe(self, samples: np.ndarray, rate: int = SAMPLE_RATE) -> str:
        self.heard.append(len(samples))
        return self.text


# ---------- speech detection ----------


class SileroVad:
    """Silero VAD through sherpa-onnx: where speech starts and stops."""

    def __init__(self, min_silence: float = 0.6, threshold: float = 0.5) -> None:
        import sherpa_onnx

        path = models_dir() / "vad" / "silero_vad.onnx"
        if not path.exists():
            raise FileNotFoundError("the speech detection model is not installed")
        config = sherpa_onnx.VadModelConfig()
        config.silero_vad.model = str(path)
        config.silero_vad.threshold = threshold
        config.silero_vad.min_silence_duration = min_silence
        config.silero_vad.min_speech_duration = 0.2
        config.sample_rate = SAMPLE_RATE
        self._config = config
        self._window = config.silero_vad.window_size
        self._sherpa = sherpa_onnx
        self.reset()

    def reset(self) -> None:
        self._vad = self._sherpa.VoiceActivityDetector(self._config, buffer_size_in_seconds=60)
        self._pending = np.zeros(0, dtype=np.float32)

    def feed(self, chunk: np.ndarray) -> None:
        self._pending = np.concatenate([self._pending, np.asarray(chunk, dtype=np.float32)])
        while len(self._pending) >= self._window:
            self._vad.accept_waveform(self._pending[: self._window])
            self._pending = self._pending[self._window :]

    def speaking(self) -> bool:
        return bool(self._vad.is_speech_detected())

    def segments(self, flush: bool = False) -> list[np.ndarray]:
        """Finished stretches of speech since the last call."""
        if flush:
            self._vad.flush()
        found = []
        while not self._vad.empty():
            found.append(np.array(self._vad.front.samples, dtype=np.float32))
            self._vad.pop()
        return found

    def trim(self, samples: np.ndarray) -> np.ndarray:
        """Only the speech in a recording, with the silence around it removed."""
        self.reset()
        self.feed(samples)
        parts = self.segments(flush=True)
        self.reset()
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


# ---------- text to speech ----------

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text: str) -> list[str]:
    """Sentences are synthesised one at a time, so the first one can be
    heard while the rest is still being made."""
    return [part.strip() for part in _SENTENCE_END.split(text) if part.strip()]


class TtsEngine(Protocol):
    name: str

    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]: ...

    def voices(self) -> list[str]: ...


class KokoroTts:
    """Kokoro 82M through kokoro-onnx, on the CPU."""

    def __init__(self, model: str = "int8") -> None:
        from kokoro_onnx import Kokoro

        folder = models_dir() / "tts"
        if not (folder / TTS_MODELS[model]).exists():
            raise FileNotFoundError(f"voice model {model} is not installed")
        self.name = f"kokoro-{model}"
        self._kokoro = Kokoro(str(folder / TTS_MODELS[model]), str(folder / "voices-v1.0.bin"))

    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        samples, rate = self._kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        return np.asarray(samples, dtype=np.float32), int(rate)

    def voices(self) -> list[str]:
        return sorted(self._kokoro.get_voices())


class FakeTts:
    name = "fake"

    def __init__(self) -> None:
        self.spoken: list[str] = []

    def synthesize(self, text: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        self.spoken.append(text)
        return np.zeros(2_400, dtype=np.float32), 24_000

    def voices(self) -> list[str]:
        return ["am_michael", "am_adam"]


# ---------- the wake word ----------


class WakeEngine(Protocol):
    name: str

    def score(self, chunk: np.ndarray) -> float:
        """How sure the model is, from 0 to 1, that the wake phrase just ended."""

    def reset(self) -> None: ...


class OpenWakeWord:
    """openWakeWord. `model` is a file in the wake folder of the models
    directory. "Hey Helios" has no model yet: it has to be trained first
    (see docs/AI-VOICE-STACK.md). A stock model is used to test the wiring."""

    def __init__(self, model: str = "hey_jarvis_v0.1.onnx") -> None:
        from openwakeword.model import Model

        folder = models_dir() / "wake"
        if not (folder / model).exists():
            raise FileNotFoundError(f"wake model {model} is not installed")
        self.name = Path(model).stem
        self._model = Model(
            wakeword_models=[str(folder / model)],
            inference_framework="onnx",
            melspec_model_path=str(folder / "melspectrogram.onnx"),
            embedding_model_path=str(folder / "embedding_model.onnx"),
        )
        self._pending = np.zeros(0, dtype=np.int16)

    def score(self, chunk: np.ndarray) -> float:
        # openWakeWord wants 80 ms frames (1,280 samples) of 16-bit audio.
        ints = (np.clip(chunk, -1.0, 1.0) * 32767).astype(np.int16)
        self._pending = np.concatenate([self._pending, ints])
        best = 0.0
        while len(self._pending) >= 1280:
            scores = self._model.predict(self._pending[:1280])
            self._pending = self._pending[1280:]
            best = max(best, float(max(scores.values())))
        return best

    def reset(self) -> None:
        self._model.reset()
        self._pending = np.zeros(0, dtype=np.int16)


class FakeWake:
    name = "fake"

    def __init__(self) -> None:
        self.next_score = 0.0
        self.chunks = 0

    def score(self, chunk: np.ndarray) -> float:
        self.chunks += 1
        value, self.next_score = self.next_score, 0.0
        return value

    def reset(self) -> None:
        pass
