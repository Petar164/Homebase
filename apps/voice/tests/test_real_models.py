"""The real models, end to end, still without any audio hardware: HELIOS's
voice is synthesised into memory and that sound is played back into the
worker as if it came from the microphone.

Skipped when the model files are not installed."""

import io
import json
import time

import numpy as np
import pytest

from helios_voice.audio import SAMPLE_RATE, MockAudioBackend, resample
from helios_voice.engines import STT_MODELS, models_dir
from helios_voice.protocol import Channel
from helios_voice.worker import Worker

pytestmark = pytest.mark.skipif(not (models_dir() / "tts" / "voices-v1.0.bin").exists(), reason="speech models are not installed")

SENTENCE = "Your focus for today is the database assignment."


def words(text: str) -> list[str]:
    return "".join(ch for ch in text.lower() if ch.isalnum() or ch.isspace()).split()


@pytest.fixture(scope="module")
def spoken():
    """One sentence in HELIOS's voice, as 16 kHz microphone audio with silence around it."""
    from helios_voice.engines import KokoroTts

    samples, rate = KokoroTts("int8").synthesize(SENTENCE, "am_michael", 1.0)
    silence = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
    return np.concatenate([silence, resample(samples, rate, SAMPLE_RATE), silence])


@pytest.mark.parametrize("model", sorted(STT_MODELS))
def test_each_recogniser_understands_the_voice(model, spoken):
    from helios_voice.engines import ParakeetStt

    assert words(ParakeetStt(model).transcribe(spoken)) == words(SENTENCE)


def test_speech_detection_cuts_away_the_silence(spoken):
    from helios_voice.engines import SileroVad

    speech = SileroVad().trim(spoken)
    assert 0.5 * SAMPLE_RATE < len(speech) < len(spoken) - 0.5 * SAMPLE_RATE
    assert len(SileroVad().trim(np.zeros(SAMPLE_RATE * 2, dtype=np.float32))) == 0  # silence contains no speech


def test_the_whole_worker_with_real_models(spoken):
    from helios_voice.engines import KokoroTts, ParakeetStt, SileroVad

    out, audio = io.StringIO(), MockAudioBackend()
    worker = Worker(Channel(out), audio, lambda: ParakeetStt("parakeet-unified"), lambda: KokoroTts("int8"), SileroVad, None)
    events = lambda kind: [e for e in map(json.loads, out.getvalue().splitlines()) if e["type"] == kind]  # noqa: E731

    def wait(kind, timeout=30.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not events(kind):
            time.sleep(0.02)
        assert events(kind), f"no {kind}"
        return events(kind)[0]

    worker.handle({"type": "listen_start"})
    audio.feed(spoken)
    worker.handle({"type": "listen_stop"})
    assert words(wait("transcript")["text"]) == words(SENTENCE)

    worker.handle({"type": "speak", "id": "a1", "text": "Understood. I will remind you."})
    worker.handle({"type": "speak_end", "id": "a1"})
    assert wait("speech_finished")["interrupted"] is False
    assert len(audio.played) == 2  # two sentences, played one after the other
    assert all(rate == 24_000 and len(samples) > 12_000 for samples, rate in audio.played)


def test_the_stock_wake_model_hears_its_phrase_and_ignores_other_speech(spoken):
    from helios_voice.engines import KokoroTts, OpenWakeWord

    wake = OpenWakeWord("hey_jarvis_v0.1.onnx")
    tts = KokoroTts("int8")

    def best_score(text: str) -> float:
        wake.reset()
        samples, rate = tts.synthesize(text, "am_michael", 1.0)
        padded = np.concatenate([np.zeros(SAMPLE_RATE, dtype=np.float32), resample(samples, rate, SAMPLE_RATE), np.zeros(SAMPLE_RATE, dtype=np.float32)])
        return max(wake.score(padded[start : start + 1600]) for start in range(0, len(padded), 1600))

    assert best_score("Hey Jarvis.") > 0.5
    assert best_score("Your focus for today is the database assignment.") < 0.2
