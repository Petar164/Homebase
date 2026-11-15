"""Checks with a real microphone and real speakers, for a new machine.

    uv run python -m helios_voice.check devices
    uv run python -m helios_voice.check speaker
    uv run python -m helios_voice.check mic
    uv run python -m helios_voice.check read --label "two metres, quiet"
    uv run python -m helios_voice.check echo
    uv run python -m helios_voice.check echo --stop-after 1.5
    uv run python -m helios_voice.check turns --log core.log

Add `--out results.json` to any of them to keep the numbers.

    devices   which microphones and speakers the sound system offers
    speaker   one sentence in HELIOS's voice: can it be heard?
    mic       a few seconds of the microphone: how loud is speech, how loud
              is the room, does anything arrive at all?
    read      ten sentences read aloud and recognised: how many words are
              right from this seat, in this room?
    echo      HELIOS speaks while the microphone listens: how late and how
              loud does its own voice come back, and how long until the room
              is quiet again? With --stop-after: how long does it take to
              fall silent when told to stop?
    turns     no device at all: reads the core's log and gives the middle
              value, the 90th percentile and the slowest of the last ten
              spoken exchanges

Rules of these checks:
  - Someone has to be there. They open the microphone and make sound, so
    each one says what it will do and waits for Enter (--yes skips that).
  - They use the worker's own audio class and the worker's own steps
    (capture, cut the silence away, recognise), but outside any
    conversation: nothing is stored in Home Base and no model answers.
  - What was heard is shown on the terminal and nowhere else. A results
    file holds numbers and the label given on the command line. It holds
    no words and no device names.
  - Nothing is estimated and nothing is judged. A figure that could not be
    taken is reported as missing. Whether a figure is good enough is
    decided against docs/PHASE-2-ACCEPTANCE.md, not here.
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from .audio import BLOCK, SAMPLE_RATE, AudioBackend, AudioUnavailable
from .bench import SENTENCES, word_errors, words
from .models import ModelUnavailable

#: What HELIOS says in the speaker and echo checks.
SPOKEN = "Your focus for today is the database assignment, which is three days late. After that, photograph the new stock."
FINE = SAMPLE_RATE // 100  # 10 ms: the step in which loudness is followed over time
QUIET_FOR = 20  # this many steps in a row below the line count as quiet again (200 ms)
SILENT_DB = -90.0  # below this a microphone is delivering nothing at all

SILENT_HELP = (
    "The microphone opened but delivered nothing at all. On Windows that is what a blocked microphone looks like: "
    "Settings > Privacy & security > Microphone, and allow desktop apps to use it. Otherwise check that it is not muted "
    "and that the right one is chosen (see: check devices)."
)


class CheckFailed(Exception):
    """A check could not be carried out. The message says why and is safe to show."""


@dataclass
class Kit:
    """Everything a check touches from outside, so a test can replace it."""

    backend: AudioBackend
    make_stt: Callable[[], object]
    make_tts: Callable[[], object]
    make_vad: Callable[[], object]
    make_wake: Callable[[], object] | None = None
    sound_system: Callable[[object, object], dict] = lambda _input, _output: {}
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    show: Callable[[str], None] = lambda text: print(text, flush=True)
    ask: Callable[[str], str] = input
    input_device: str | int | None = None
    output_device: str | int | None = None
    voice: str = "am_michael"
    gain: float = 1.0


# ---------- loudness ----------


def level_db(samples: np.ndarray) -> float:
    """Loudness in dB below full scale: 0 is the loudest a sample can be."""
    if len(samples) == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(np.asarray(samples, dtype=np.float64)))))
    return round(max(-120.0, 20 * math.log10(rms)), 1) if rms > 0 else -120.0


def levels(samples: np.ndarray, step: int) -> np.ndarray:
    """The loudness of each `step` samples in turn."""
    count = len(samples) // step
    if count == 0:
        return np.zeros(0)
    blocks = np.asarray(samples[: count * step], dtype=np.float64).reshape(count, step)
    return 20 * np.log10(np.maximum(np.sqrt(np.mean(blocks**2, axis=1)), 1e-6))


def describe_sound(samples: np.ndarray) -> dict:
    """How loud a recording is: at its peak, in its quietest tenth and in its loudest tenth."""
    by_block = levels(samples, BLOCK)
    peak = float(np.max(np.abs(samples))) if len(samples) else 0.0
    return {
        "seconds": round(len(samples) / SAMPLE_RATE, 1),
        "peak_db": round(20 * math.log10(peak), 1) if peak > 0 else -120.0,
        "quiet_db": round(float(np.percentile(by_block, 10)), 1) if len(by_block) else -120.0,
        "loud_db": round(float(np.percentile(by_block, 90)), 1) if len(by_block) else -120.0,
        "clipped": peak >= 0.99,
        "silent": peak == 0.0 or level_db(samples) < SILENT_DB,
    }


# ---------- the microphone ----------


def capture(backend: AudioBackend, device, seconds: float, sleep: Callable[[float], None], on_open: Callable[[], None] = lambda: None) -> np.ndarray:
    """What the microphone hears for `seconds`. It is opened and closed each
    time, the way a press and a release of the talk button do it."""
    chunks: list[np.ndarray] = []
    backend.open_input(device, lambda chunk: chunks.append(np.asarray(chunk, dtype=np.float32)))
    try:
        on_open()
        sleep(seconds)
    finally:
        backend.close_input()
    return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


class Recording:
    """The microphone, kept together with the moment its first piece
    arrived, so that a moment on the clock can be found in the sound."""

    def __init__(self, backend: AudioBackend, device, clock: Callable[[], float]) -> None:
        self._backend, self._device, self._clock = backend, device, clock
        self._chunks: list[np.ndarray] = []
        self._first_arrival: float | None = None

    def start(self) -> None:
        self._backend.open_input(self._device, self._on_chunk)

    def _on_chunk(self, chunk: np.ndarray) -> None:
        if self._first_arrival is None:
            self._first_arrival = self._clock()
        self._chunks.append(np.asarray(chunk, dtype=np.float32))

    def stop(self) -> np.ndarray:
        self._backend.close_input()
        return np.concatenate(self._chunks) if self._chunks else np.zeros(0, dtype=np.float32)

    def position(self, moment: float) -> int:
        """The sample that was being heard at `moment`."""
        if self._first_arrival is None:
            return 0
        began = self._first_arrival - len(self._chunks[0]) / SAMPLE_RATE  # a piece arrives when its last sample has been heard
        return max(0, int(round((moment - began) * SAMPLE_RATE)))


# ---------- the checks ----------


def check_devices(kit: Kit) -> dict:
    listing = kit.backend.devices()
    for kind, title in (("inputs", "Microphones"), ("outputs", "Speakers")):
        kit.show(f"{title}:")
        for device in listing[kind]:
            kit.show(f"  {device['id']:>3}  {device['name']}{'   <- the system default' if device['default'] else ''}")
        if not listing[kind]:
            kit.show("  none")
    try:
        system = kit.sound_system(kit.input_device, kit.output_device)
    except Exception as error:  # the sound system reports a wide range of errors
        kit.show(f"(The sound system gave no details of the devices in use: {type(error).__name__}: {error})")
        system = {}
    for kind, about in system.items():
        kit.show(f"The {kind} in use: through {about['interface']}, {about['sample_rate']} Hz, expected delay {about['delay_ms'][0]} to {about['delay_ms'][1]} ms.")
    if not listing["inputs"] or not listing["outputs"]:
        raise CheckFailed("The sound system offers no microphone or no speakers.")
    return {"check": "devices", "microphones": len(listing["inputs"]), "speakers": len(listing["outputs"]), "sound_system": system}


def check_speaker(kit: Kit, confirm: bool) -> dict:
    samples, rate = kit.make_tts().synthesize(SPOKEN, kit.voice, 1.0)
    started = kit.clock()
    kit.backend.play(samples, rate, kit.output_device, lambda: False, kit.gain)
    took = kit.clock() - started
    result: dict = {"check": "speaker", "sound_seconds": round(len(samples) / rate, 1), "playing_took_seconds": round(took, 1), "heard_by_the_person_there": None}
    kit.show(f"Played {result['sound_seconds']} seconds of HELIOS's voice in {result['playing_took_seconds']} seconds.")
    if confirm:
        result["heard_by_the_person_there"] = kit.ask("Did you hear it clearly? (y or n) ").strip().lower().startswith("y")
    return result


def check_mic(kit: Kit, seconds: float) -> dict:
    kit.show(f"Listening for {seconds:g} seconds. Say a sentence or two in your normal voice, from where you will sit.")
    samples = capture(kit.backend, kit.input_device, seconds, kit.sleep)
    result: dict = {"check": "mic", **describe_sound(samples), "speech_seconds": None}
    if not result["silent"]:
        try:
            result["speech_seconds"] = round(len(kit.make_vad().trim(samples)) / SAMPLE_RATE, 1)
        except ModelUnavailable as error:
            kit.show(f"(Speech was not counted: {error})")
    kit.show(f"Loudest moment {result['peak_db']} dB, the loud parts {result['loud_db']} dB, the quiet parts {result['quiet_db']} dB.")
    if result["speech_seconds"] is not None:
        kit.show(f"Speech was found in {result['speech_seconds']} of the {result['seconds']} seconds.")
    if result["clipped"]:
        kit.show("The loudest moment hit the limit: the microphone level is set too high.")
    return result


def window_for(sentence: str) -> float:
    """Seconds allowed for reading a sentence aloud: generous, so nobody has to hurry."""
    return max(5.0, 0.5 * len(words(sentence)) + 3.0)


def check_read(kit: Kit, label: str, sentences: list[str] = SENTENCES) -> dict:
    stt, vad = kit.make_stt(), kit.make_vad()
    kit.show("First the room by itself. Say nothing for three seconds.")
    room = capture(kit.backend, kit.input_device, 3.0, kit.sleep)
    if describe_sound(room)["silent"]:
        raise CheckFailed(SILENT_HELP)
    rows = []
    for number, sentence in enumerate(sentences, 1):
        kit.show(f"\nSentence {number} of {len(sentences)}. Read it aloud when you see GO:\n\n    {sentence}\n")
        for count in (3, 2, 1):
            kit.show(f"  {count}")
            kit.sleep(1.0)
        seconds = window_for(sentence)
        samples = capture(kit.backend, kit.input_device, seconds, kit.sleep, on_open=lambda: kit.show(f"  GO   (listening for {seconds:g} seconds)"))
        speech = vad.trim(samples)
        started = time.perf_counter()
        heard = stt.transcribe(speech, SAMPLE_RATE) if len(speech) >= SAMPLE_RATE * 0.2 else ""
        decode_ms = int((time.perf_counter() - started) * 1000)
        wrong, total = word_errors(sentence, heard)
        kit.show(f"  heard: {heard or '(nothing)'}\n  {max(0, total - wrong)} of {total} words right")
        rows.append({"words": total, "wrong": wrong, "speech_seconds": round(len(speech) / SAMPLE_RATE, 1), "speech_db": level_db(speech) if len(speech) else None, "decode_ms": decode_ms})
    wrong, total = sum(row["wrong"] for row in rows), sum(row["words"] for row in rows)
    spoken = sorted(row["speech_db"] for row in rows if row["speech_db"] is not None)
    speech_db = spoken[len(spoken) // 2] if spoken else None
    result = {
        "check": "read",
        "label": label,
        "recogniser": getattr(stt, "name", "unknown"),
        "sentences": len(rows),
        "words": total,
        "wrong": wrong,
        "word_error_percent": round(wrong / total * 100, 1) if total else None,
        "room_db": level_db(room),
        "speech_db": speech_db,
        "speech_above_room_db": round(speech_db - level_db(room), 1) if speech_db is not None else None,
        "per_sentence": rows,
    }
    kit.show(f"\n{label or 'This reading'}: {wrong} of {total} words wrong ({result['word_error_percent']}%).")
    if speech_db is not None:
        kit.show(f"The room alone {result['room_db']} dB, the speech {speech_db} dB: {result['speech_above_room_db']} dB apart.")
    return result


def quiet_from(loud: np.ndarray) -> int | None:
    """The first step from which the sound stays below the line for long
    enough to count as quiet, or None if it never does."""
    run = 0
    for index, is_loud in enumerate(loud):
        run = 0 if is_loud else run + 1
        if run == QUIET_FOR:
            return index - QUIET_FOR + 1
    return None


def analyse_echo(heard: np.ndarray, started: int, ended: int) -> dict:
    """What the microphone made of the speakers. `started` and `ended` are
    the samples at which playing began, and ended or was told to stop."""
    fine = levels(heard, FINE)

    def step(sample: int) -> int:
        return min(len(fine), max(0, sample // FINE))

    before = fine[: step(started)]
    if len(before) < QUIET_FOR:
        raise CheckFailed("The recording holds too little of the room before the sound to compare with.")
    room_db = float(np.median(before))
    line = max(room_db + 10.0, -70.0)  # clearly above the room: from here on the speakers count as heard
    loud = np.nonzero(fine[step(started) : step(ended)] > line)[0]
    result = {"room_db": round(room_db, 1), "heard": bool(len(loud)), "heard_after_ms": None, "echo_db": None, "echo_above_room_db": None, "quiet_after_ms": None}
    after = fine[step(ended) :]
    result["listened_on_for_ms"] = len(after) * 10
    if not len(loud):
        return result
    first = step(started) + int(loud[0])
    echo_db = level_db(heard[first * FINE : max(ended, (first + 1) * FINE)])
    quiet = quiet_from(after > line)
    result.update(heard_after_ms=int(loud[0]) * 10, echo_db=echo_db, echo_above_room_db=round(echo_db - room_db, 1), quiet_after_ms=None if quiet is None else quiet * 10)
    return result


def check_echo(kit: Kit, stop_after: float | None) -> dict:
    samples, rate = kit.make_tts().synthesize(SPOKEN, kit.voice, 1.0)
    recording = Recording(kit.backend, kit.input_device, kit.clock)
    recording.start()
    asked: list[float] = []
    try:
        kit.sleep(1.5)  # the room before any sound
        started = kit.clock()

        def should_stop() -> bool:
            if stop_after is not None and not asked and kit.clock() - started >= stop_after:
                asked.append(kit.clock())
            return bool(asked)

        cut_short = kit.backend.play(samples, rate, kit.output_device, should_stop, kit.gain)
        returned = kit.clock()
        kit.sleep(2.0)  # the room afterwards
    finally:
        heard = recording.stop()
    if describe_sound(heard)["silent"]:
        raise CheckFailed(SILENT_HELP)
    if stop_after is not None and not asked:
        raise CheckFailed(f"The sentence was over before the stop was due ({returned - started:.1f} seconds). Choose a smaller --stop-after.")

    reference = asked[0] if asked else returned
    result: dict = {
        "check": "echo",
        "interrupted": stop_after is not None,
        "cut_short": bool(cut_short),
        "played_for_seconds": round(returned - started, 2),
        **analyse_echo(heard, recording.position(started), recording.position(reference)),
    }
    kit.show(f"The room alone: {result['room_db']} dB.")
    if not result["heard"]:
        kit.show("The microphone did not hear the speakers at all. Check the volume and which speakers are in use.")
        return result
    kit.show(f"The microphone first heard HELIOS {result['heard_after_ms']} ms after the sound was handed to the speakers. (That includes the quiet start of the sentence itself.)")
    kit.show(f"HELIOS's voice at the microphone: {result['echo_db']} dB, which is {result['echo_above_room_db']} dB above the room.")
    quiet = "not within the " + str(result["listened_on_for_ms"]) + " ms listened" if result["quiet_after_ms"] is None else f"after {result['quiet_after_ms']} ms"
    if asked:
        result["playing_returned_after_ms"] = int(round((returned - asked[0]) * 1000))
        kit.show(f"Told to stop after {stop_after:g} seconds. Playing handed back control after {result['playing_returned_after_ms']} ms.")
        kit.show(f"The room was quiet again {quiet}, counted from the stop. (The worker itself looks for a stop every 50 ms; that comes on top.)")
        return result
    kit.show(f"The room was quiet again {quiet}, counted from the end of playing. (After speaking, HELIOS ignores the microphone for its guard time: 500 ms unless changed.)")

    # Would HELIOS understand, or be woken by, its own voice? Only numbers are kept.
    start = recording.position(started)
    echo = heard[start:]
    result["own_words"] = len(words(SPOKEN))
    result["own_words_recognised"] = None
    result["wake_score_on_own_voice"] = None
    try:
        speech = kit.make_vad().trim(echo)
        text = kit.make_stt().transcribe(speech, SAMPLE_RATE) if len(speech) >= SAMPLE_RATE * 0.2 else ""
        wrong, total = word_errors(SPOKEN, text)
        result["own_words_recognised"] = max(0, total - wrong)
        kit.show(f"The recogniser made out {result['own_words_recognised']} of HELIOS's {total} own words from the microphone.")
    except ModelUnavailable as error:
        kit.show(f"(Not measured, what the recogniser makes of it: {error})")
    if kit.make_wake is not None:
        try:
            wake = kit.make_wake()
            result["wake_score_on_own_voice"] = round(max((float(wake.score(echo[at : at + BLOCK])) for at in range(0, len(echo), BLOCK)), default=0.0), 3)
            kit.show(f"The wake model's highest score on HELIOS's own voice: {result['wake_score_on_own_voice']} (it wakes at 0.5 unless changed).")
        except Exception as error:  # the wake word is optional: its package or its model may be absent
            kit.show(f"(Not measured, the wake model on its own voice: {error if isinstance(error, ModelUnavailable) else type(error).__name__})")
    return result


# ---------- the time from the end of speech to the first sound ----------

#: The line the core writes for every spoken exchange (apps/core/src/voice/service.ts).
TURN = re.compile(r"Spoken turn: transcript after (\d+) ms, first text after (\d+|\?) ms, first sound after (\d+) ms\.")


def summarise(values: list[int]) -> dict:
    """The middle value, the 90th percentile and the slowest of some runs.
    The 90th percentile is the value that nine runs in ten do not exceed:
    of ten runs in order, the ninth."""
    ordered = sorted(values)
    count = len(ordered)
    middle = ordered[count // 2] if count % 2 else (ordered[count // 2 - 1] + ordered[count // 2]) / 2
    return {"median_ms": int(middle) if middle == int(middle) else middle, "ninetieth_percentile_ms": ordered[math.ceil(0.9 * count) - 1], "slowest_ms": ordered[-1]}


def check_turns(show: Callable[[str], None], log: Path, last: int, speaker_delay_ms: int | None) -> dict:
    """Reads the spoken exchanges out of the core's log. The log holds
    durations only, so nothing that was said can be read from it."""
    try:
        text = log.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        raise CheckFailed(f"The log could not be read: {error}") from error
    found = [(int(transcript), None if first_text == "?" else int(first_text), int(sound)) for transcript, first_text, sound in TURN.findall(text)]
    if not found:
        raise CheckFailed("That file holds no line of a spoken exchange. Start the core with its output kept in a file, ask by voice, then name that file.")
    counted = found[-last:]
    result: dict = {
        "check": "turns",
        "exchanges_in_the_log": len(found),
        "counted": len(counted),
        "to_transcript": summarise([transcript for transcript, _, _ in counted]),
        "to_first_text": summarise([first_text for _, first_text, _ in counted if first_text is not None]) if any(first_text is not None for _, first_text, _ in counted) else None,
        "to_first_sound": summarise([sound for _, _, sound in counted]),
        "speaker_delay_ms": speaker_delay_ms,
        "to_first_sound_heard": summarise([sound + speaker_delay_ms for _, _, sound in counted]) if speaker_delay_ms is not None else None,
    }
    show(f"{len(found)} spoken exchanges in the log. The last {len(counted)} are counted, from the release of the talk button:")
    for title, key in (("to the transcript", "to_transcript"), ("to the model's first sentence", "to_first_text"), ("to the first sound handed to the speakers", "to_first_sound"), (f"to the first sound heard (the speakers' own {speaker_delay_ms} ms added)", "to_first_sound_heard")):
        figures = result[key]
        if figures is not None:
            show(f"  {title}: middle value {figures['median_ms']} ms, 90th percentile {figures['ninetieth_percentile_ms']} ms, slowest {figures['slowest_ms']} ms")
    if speaker_delay_ms is None:
        show("  (The delay of the speakers themselves is not in these figures. Give it with --speaker-delay, from the echo check.)")
    if len(counted) != last:
        show(f"  Only {len(counted)} exchanges were found; {last} were asked for.")
    return result


# ---------- the command ----------

ABOUT_TO = {
    "speaker": "This plays one sentence in HELIOS's voice through the speakers.",
    "mic": "This listens with the microphone for a few seconds. Nothing is kept but its loudness.",
    "read": "This shows ten sentences, one at a time, and listens while you read each aloud. It takes about three minutes.",
    "echo": "This plays one sentence in HELIOS's voice through the speakers and listens with the microphone at the same time, for about twelve seconds. Stay quiet while it runs.",
}


def machine() -> dict:
    return {"system": f"{platform.system()} {platform.release()}", "processor": platform.processor() or platform.machine(), "python": platform.python_version()}


def record(path: Path, result: dict) -> None:
    """Adds one check to a results file, creating the file if needed."""
    data: dict = {}
    if path.exists():
        try:
            found = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            found = None
        if not isinstance(found, dict) or not isinstance(found.get("checks", []), list):
            raise CheckFailed(f"{path} is not a results file of these checks. Choose another name.")
        data = found
    data.setdefault("machine", machine())
    data.setdefault("note", "Taken with a real microphone and real speakers. Loudness is in dB below full scale. No words and no device names are kept.")
    data.setdefault("checks", []).append({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **result})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def sound_system(input_device, output_device) -> dict:
    """What the sound system says about the two devices in use."""
    import sounddevice

    found = {}
    for kind, device in (("input", input_device), ("output", output_device)):
        info = sounddevice.query_devices(device, kind)
        found["microphone" if kind == "input" else "speakers"] = {
            "interface": sounddevice.query_hostapis(info["hostapi"])["name"],
            "sample_rate": int(info["default_samplerate"]),
            "delay_ms": [round(info[f"default_low_{kind}_latency"] * 1000), round(info[f"default_high_{kind}_latency"] * 1000)],
        }
    return found


def real_kit(args: argparse.Namespace) -> Kit:
    from .audio import SoundDeviceBackend
    from .engines import KokoroTts, OpenWakeWord, ParakeetStt, SileroVad

    return Kit(
        backend=SoundDeviceBackend(),
        make_stt=lambda: ParakeetStt(args.stt),
        make_tts=lambda: KokoroTts(args.tts),
        make_vad=SileroVad,
        make_wake=lambda: OpenWakeWord(args.wake),
        sound_system=sound_system,
    )


def device(value: str | None) -> str | int | None:
    return int(value) if value is not None and value.lstrip("-").isdigit() else value


def main(argv: list[str] | None = None, kit: Kit | None = None) -> int:
    parser = argparse.ArgumentParser(prog="helios_voice.check", description="Checks with a real microphone and real speakers.")
    parser.add_argument("check", choices=["devices", "speaker", "mic", "read", "echo", "turns"])
    parser.add_argument("--log", default="", help="turns: the file the core's output was kept in")
    parser.add_argument("--last", type=int, default=10, help="turns: how many of the latest spoken exchanges to count")
    parser.add_argument("--speaker-delay", type=int, default=None, help="turns: the 'first heard after' figure of the echo check, in ms, to add to the first sound")
    parser.add_argument("--input", default=None, help="the microphone, by number or name (default: the system's)")
    parser.add_argument("--output", default=None, help="the speakers, by number or name (default: the system's)")
    parser.add_argument("--seconds", type=float, default=6.0, help="mic: how long to listen")
    parser.add_argument("--label", default="", help="read: where you sit and what the room is like, for example 'two metres, TV on'. It is written to the results file")
    parser.add_argument("--stop-after", type=float, default=None, help="echo: tell HELIOS to stop after this many seconds")
    parser.add_argument("--stt", default="parakeet-unified")
    parser.add_argument("--tts", default="int8")
    parser.add_argument("--voice", default="am_michael")
    parser.add_argument("--gain", type=float, default=1.0, help="playback volume, from 0 to 1")
    parser.add_argument("--wake", default="hey_jarvis_v0.1.onnx")
    parser.add_argument("--out", default="", help="add the numbers to this file")
    parser.add_argument("--yes", action="store_true", help="do not wait for Enter before listening or making sound")
    args = parser.parse_args(argv)

    if args.check == "turns":  # reads a file: no microphone, no speakers, no model
        show = kit.show if kit is not None else (lambda text: print(text, flush=True))
        try:
            if not args.log:
                raise CheckFailed("Name the file the core's output was kept in, with --log.")
            if args.last < 1:
                raise CheckFailed("--last has to be 1 or more.")
            result = check_turns(show, Path(args.log), args.last, args.speaker_delay)
            if args.out:
                record(Path(args.out), result)
                show(f"Added to {args.out}.")
        except CheckFailed as error:
            show(f"Not done: {error}")
            return 1
        return 0

    kit = kit or real_kit(args)
    kit.input_device, kit.output_device, kit.voice, kit.gain = device(args.input), device(args.output), args.voice, args.gain
    try:
        if args.check in ABOUT_TO and not args.yes:
            kit.show(ABOUT_TO[args.check])
            kit.ask("Press Enter to start, or Ctrl+C to leave. ")
        if args.check == "devices":
            result = check_devices(kit)
        elif args.check == "speaker":
            result = check_speaker(kit, confirm=not args.yes)
        elif args.check == "mic":
            result = check_mic(kit, args.seconds)
        elif args.check == "read":
            result = check_read(kit, args.label)
        else:
            result = check_echo(kit, args.stop_after)
        if args.out:
            record(Path(args.out), result)
            kit.show(f"Added to {args.out}.")
    except (CheckFailed, ModelUnavailable) as error:
        kit.show(f"Not done: {error}")
        return 1
    except AudioUnavailable as error:
        # A device problem holds no words, so the sound system's own message is shown in full.
        cause = f" The sound system said: {error.__cause__}" if error.__cause__ is not None else ""
        kit.show(f"Not done: the microphone or the speakers could not be used ({error}).{cause}")
        return 1
    if result.get("silent"):
        kit.show(SILENT_HELP)
        return 1
    return 0 if result.get("heard", True) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(130)
