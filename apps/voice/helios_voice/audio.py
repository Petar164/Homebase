"""Microphones and speakers.

The worker only knows the small interface below. The real implementation
uses PortAudio through `sounddevice`; the mock one keeps everything in
memory, so the worker can be tested without any audio hardware.
"""

from __future__ import annotations

import threading
from typing import Callable, Protocol

import numpy as np

SAMPLE_RATE = 16_000  # what the recogniser, the speech detector and the wake word all expect
BLOCK = 1_600  # 100 ms of microphone audio per chunk


class AudioUnavailable(Exception):
    """The microphone or the speaker could not be opened or stopped working."""


class AudioBackend(Protocol):
    def devices(self) -> dict: ...

    def open_input(self, device: str | int | None, on_chunk: Callable[[np.ndarray], None]) -> None:
        """Starts delivering 16 kHz mono float32 chunks to `on_chunk`."""

    def close_input(self) -> None: ...

    def play(self, samples: np.ndarray, rate: int, device: str | int | None, should_stop: Callable[[], bool], gain: float = 1.0) -> bool:
        """Plays audio, checking `should_stop` many times a second. Returns
        True when playback was cut short."""


class SoundDeviceBackend:
    """Real audio, through PortAudio."""

    def __init__(self) -> None:
        import sounddevice  # imported here so tests never need audio hardware

        self._sd = sounddevice
        self._input = None

    def devices(self) -> dict:
        try:
            listing = self._sd.query_devices()
            default_in, default_out = self._sd.default.device
        except Exception as error:  # PortAudio reports a wide range of errors
            raise AudioUnavailable(type(error).__name__) from error
        inputs, outputs = [], []
        for index, device in enumerate(listing):
            entry = {"id": index, "name": device["name"]}
            if device["max_input_channels"] > 0:
                inputs.append({**entry, "default": index == default_in})
            if device["max_output_channels"] > 0:
                outputs.append({**entry, "default": index == default_out})
        return {"inputs": inputs, "outputs": outputs}

    def open_input(self, device, on_chunk) -> None:
        self.close_input()

        def callback(indata, _frames, _time, _status) -> None:
            on_chunk(indata[:, 0].copy())

        try:
            self._input = self._sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", blocksize=BLOCK, device=device, callback=callback)
            self._input.start()
        except Exception as error:
            self._input = None
            raise AudioUnavailable(type(error).__name__) from error

    def close_input(self) -> None:
        stream, self._input = self._input, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass  # a device that vanished cannot be closed politely

    def play(self, samples, rate, device, should_stop, gain=1.0) -> bool:
        block = max(1, rate // 20)  # 50 ms: how quickly speech can be interrupted
        data = (np.asarray(samples, dtype=np.float32) * gain).reshape(-1, 1)
        try:
            with self._sd.OutputStream(samplerate=rate, channels=1, dtype="float32", device=device) as stream:
                for start in range(0, len(data), block):
                    if should_stop():
                        return True
                    stream.write(data[start : start + block])
        except Exception as error:
            raise AudioUnavailable(type(error).__name__) from error
        return False


class MockAudioBackend:
    """Audio that exists only in memory, for tests."""

    def __init__(self) -> None:
        self.played: list[tuple[np.ndarray, int]] = []
        self.input_open = False
        self.fail_input = False
        self.fail_output = False
        self.play_seconds = 0.0  # pretend playback takes this long per call
        self.auto_feed_seconds = 0.0  # when set, opening the microphone "hears" this much silence at once
        self._on_chunk: Callable[[np.ndarray], None] | None = None
        self.playing = threading.Event()

    def devices(self) -> dict:
        return {"inputs": [{"id": 0, "name": "Mock microphone", "default": True}], "outputs": [{"id": 1, "name": "Mock speaker", "default": True}]}

    def open_input(self, device, on_chunk) -> None:
        if self.fail_input:
            raise AudioUnavailable("MockDeviceMissing")
        self._on_chunk = on_chunk
        self.input_open = True
        if self.auto_feed_seconds > 0:
            self.feed(np.zeros(int(self.auto_feed_seconds * SAMPLE_RATE), dtype=np.float32))

    def close_input(self) -> None:
        self._on_chunk = None
        self.input_open = False

    def feed(self, samples: np.ndarray) -> None:
        """Delivers microphone audio, in chunks, as a real device would."""
        for start in range(0, len(samples), BLOCK):
            if self._on_chunk is not None:
                self._on_chunk(np.asarray(samples[start : start + BLOCK], dtype=np.float32))

    def play(self, samples, rate, device, should_stop, gain=1.0) -> bool:
        if self.fail_output:
            raise AudioUnavailable("MockSpeakerMissing")
        self.playing.set()
        try:
            waited = 0.0
            while waited < self.play_seconds:
                if should_stop():
                    return True
                threading.Event().wait(0.01)
                waited += 0.01
            if should_stop():
                return True
            self.played.append((np.asarray(samples, dtype=np.float32), rate))
            return False
        finally:
            self.playing.clear()


def resample(samples: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """Changes the sample rate by linear interpolation. Good enough for
    speech going into a recogniser; not for music."""
    if from_rate == to_rate or len(samples) == 0:
        return np.asarray(samples, dtype=np.float32)
    duration = len(samples) / from_rate
    target = np.linspace(0.0, duration, int(duration * to_rate), endpoint=False)
    source = np.arange(len(samples)) / from_rate
    return np.interp(target, source, samples).astype(np.float32)
