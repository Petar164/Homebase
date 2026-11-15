"""The checks for a real microphone and real speakers, run here in a room
that exists only in the test: a microphone that hears, a little later and
quieter, whatever the speaker plays, on a clock the test controls.

So these tests say that the arithmetic and the order of steps are right.
They say nothing about any real device."""

import json
import re
from pathlib import Path

import numpy as np
import pytest

from helios_voice import check
from helios_voice.audio import BLOCK, SAMPLE_RATE, AudioUnavailable, resample
from helios_voice.engines import models_dir

VOICE_RATE = 24_000


def a_voice(seconds: float = 3.0) -> np.ndarray:
    """Something word-like: bursts of a tone with short gaps, ending on sound."""
    t = np.arange(int(seconds * VOICE_RATE)) / VOICE_RATE
    tone = 0.3 * np.sin(2 * np.pi * 220 * t)
    on = ((t % 0.3) < 0.25) | (t > seconds - 0.25)
    return (tone * on).astype(np.float32)


class Room:
    def __init__(self, delay: float = 0.12, echo: float = 0.1, hiss: float = 0.001, drain: float = 0.0) -> None:
        self.now = 0.0
        self.delay, self.echo, self.hiss, self.drain = delay, echo, hiss, drain
        self._air = np.zeros(SAMPLE_RATE * 300, dtype=np.float32)  # the sound in the room, by time
        self._on_chunk = None
        self._heard_until = 0
        self._noise = np.random.default_rng(7)
        self.opened = 0
        self.fail_input = False

    # the clock
    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        target = self.now + seconds
        while self._on_chunk is not None and (self._heard_until + BLOCK) / SAMPLE_RATE <= target + 1e-9:
            start, self._heard_until = self._heard_until, self._heard_until + BLOCK
            self.now = self._heard_until / SAMPLE_RATE  # a piece arrives when its last sample has been heard
            self._on_chunk(self._air[start : start + BLOCK] + self._noise.standard_normal(BLOCK).astype(np.float32) * self.hiss)
        self.now = target

    # the audio backend
    def devices(self) -> dict:
        return {"inputs": [{"id": 0, "name": "Room microphone", "default": True}], "outputs": [{"id": 1, "name": "Room speaker", "default": True}]}

    def open_input(self, device, on_chunk) -> None:
        if self.fail_input:
            raise AudioUnavailable("PortAudioError") from RuntimeError("Invalid sample rate")
        self.opened += 1
        self._on_chunk = on_chunk
        self._heard_until = int(round(self.now * SAMPLE_RATE))

    def close_input(self) -> None:
        self._on_chunk = None

    def play(self, samples, rate, device, should_stop, gain=1.0) -> bool:
        data = resample(np.asarray(samples, dtype=np.float32) * gain, rate, SAMPLE_RATE)
        step = SAMPLE_RATE // 20
        for start in range(0, len(data), step):
            if should_stop():
                self._into_the_air(data[start : start + int(self.drain * SAMPLE_RATE)])  # what was already handed over still comes out
                self.sleep(self.drain)
                return True
            self._into_the_air(data[start : start + step])
            self.sleep(step / SAMPLE_RATE)
        return False

    def _into_the_air(self, block: np.ndarray) -> None:
        start = int(round((self.now + self.delay) * SAMPLE_RATE))
        self._air[start : start + len(block)] += block * self.echo

    def someone_says(self, samples: np.ndarray, after: float = 0.0) -> None:
        start = int(round((self.now + after) * SAMPLE_RATE))
        self._air[start : start + len(samples)] += samples


class ToneVoice:
    name = "tone"

    def synthesize(self, text, voice, speed):
        return a_voice(), VOICE_RATE


class WholeRecording:
    """Speech detection that keeps everything."""

    def trim(self, samples):
        return samples


class Scripted:
    """A recogniser that says what the test tells it to, one answer per call."""

    name = "scripted"

    def __init__(self, *answers: str) -> None:
        self.answers = list(answers)

    def transcribe(self, samples, rate=SAMPLE_RATE):
        return self.answers.pop(0) if self.answers else ""


def a_kit(room: Room, stt=None, **more) -> tuple[check.Kit, list[str]]:
    shown: list[str] = []
    kit = check.Kit(
        backend=room,
        make_stt=lambda: stt or Scripted(),
        make_tts=ToneVoice,
        make_vad=WholeRecording,
        clock=room.clock,
        sleep=room.sleep,
        show=shown.append,
        ask=lambda question: shown.append(f"ASKED: {question}") or "y",
        **more,
    )
    return kit, shown


# ---------- the echo check ----------


def test_the_echo_check_finds_how_late_and_how_loud_helios_comes_back():
    kit, shown = a_kit(Room(delay=0.12, echo=0.1))
    result = check.check_echo(kit, stop_after=None)

    played = resample(a_voice(), VOICE_RATE, SAMPLE_RATE)
    assert result["heard"] is True and result["cut_short"] is False
    assert abs(result["room_db"] - (-60)) <= 3  # the hiss of this room
    assert abs(result["heard_after_ms"] - 120) <= 20
    assert abs(result["echo_db"] - (check.level_db(played) - 20)) <= 1.5  # a tenth as loud is 20 dB less
    assert abs(result["quiet_after_ms"] - 120) <= 30  # the last of it was still on its way when playing ended
    assert abs(result["played_for_seconds"] - 3.0) <= 0.1
    assert any(f"heard HELIOS {result['heard_after_ms']} ms after" in line for line in shown)


def test_a_stop_is_timed_until_the_room_is_quiet():
    kit, shown = a_kit(Room(delay=0.05, drain=0.2))  # 200 ms of sound was already handed over when the stop came
    result = check.check_echo(kit, stop_after=0.88)  # looked for every 50 ms, so it lands at 0.9 s, inside a burst of the voice

    assert result["interrupted"] is True and result["cut_short"] is True
    assert result["played_for_seconds"] < 1.5  # most of the sentence was never played
    assert abs(result["playing_returned_after_ms"] - 200) <= 10
    assert abs(result["quiet_after_ms"] - 250) <= 30
    assert "own_words_recognised" not in result  # a cut-off sentence is not used for anything else
    assert any("Told to stop" in line for line in shown)


def test_a_stop_that_never_came_is_not_reported_as_one():
    kit, _ = a_kit(Room())
    with pytest.raises(check.CheckFailed, match="smaller --stop-after"):
        check.check_echo(kit, stop_after=60.0)


def test_speakers_the_microphone_cannot_hear_are_reported_as_such():
    kit, shown = a_kit(Room(echo=0.0))
    result = check.check_echo(kit, stop_after=None)
    assert result["heard"] is False
    assert result["heard_after_ms"] is None and result["echo_db"] is None and result["quiet_after_ms"] is None
    assert any("did not hear the speakers" in line for line in shown)


def test_a_room_that_never_goes_quiet_gives_no_figure():
    room = Room(delay=0.05)
    kit, _ = a_kit(room)
    room.someone_says(np.full(SAMPLE_RATE * 20, 0.2, dtype=np.float32), after=2.0)  # a television that is left on
    assert check.check_echo(kit, stop_after=None)["quiet_after_ms"] is None


def test_what_the_recogniser_and_the_wake_model_make_of_helioss_own_voice_is_counted_not_kept():
    class Wake:
        def score(self, chunk):
            return 0.07

    heard = "your focus for today is the database assignment which is three days late"  # 13 of the 19 words
    kit, shown = a_kit(Room(), stt=Scripted(heard), make_wake=Wake)
    result = check.check_echo(kit, stop_after=None)
    assert (result["own_words"], result["own_words_recognised"], result["wake_score_on_own_voice"]) == (19, 13, 0.07)
    assert "database" not in json.dumps(result) and not any("database" in line for line in shown)


def test_a_wake_model_that_is_not_there_leaves_its_figure_empty():
    def no_wake():
        raise ModuleNotFoundError("openwakeword")

    kit, shown = a_kit(Room(), make_wake=no_wake)
    assert check.check_echo(kit, stop_after=None)["wake_score_on_own_voice"] is None
    assert any("Not measured" in line and "ModuleNotFoundError" in line for line in shown)


# ---------- the microphone ----------


def test_the_microphone_check_tells_speech_from_the_room():
    room = Room(hiss=0.001)
    kit, _ = a_kit(room)
    room.someone_says(np.full(SAMPLE_RATE * 2, 0.1, dtype=np.float32), after=1.0)  # two seconds at -20 dB in a six second recording
    result = check.check_mic(kit, 6.0)
    assert result["seconds"] == 6.0 and result["silent"] is False and result["clipped"] is False
    assert abs(result["loud_db"] - (-20)) <= 1 and abs(result["quiet_db"] - (-60)) <= 3
    assert room.opened == 1 and room._on_chunk is None  # opened once, and closed again


def test_a_microphone_that_delivers_nothing_is_called_silent_and_one_that_is_too_loud_clipped():
    kit, _ = a_kit(Room(hiss=0.0))
    assert check.check_mic(kit, 2.0)["silent"] is True

    room = Room()
    kit, shown = a_kit(room)
    room.someone_says(np.ones(SAMPLE_RATE, dtype=np.float32))
    assert check.check_mic(kit, 2.0)["clipped"] is True
    assert any("too high" in line for line in shown)


# ---------- reading aloud ----------

THREE = ["What is due this week?", "Add a task to call the dentist next Friday at three.", "Stop. Never mind."]


def test_reading_aloud_counts_the_wrong_words_and_keeps_none_of_them():
    room = Room()
    stt = Scripted("what is due this week", "add a task to call the dentist next friday at 3", "")
    kit, shown = a_kit(room, stt=stt)
    result = check.check_read(kit, "two metres, quiet", THREE)

    assert (result["sentences"], result["words"], result["wrong"]) == (3, 19, 4)  # one word different, and a sentence of three not heard
    assert [row["wrong"] for row in result["per_sentence"]] == [0, 1, 3]
    assert result["word_error_percent"] == 21.1 and result["label"] == "two metres, quiet" and result["recogniser"] == "scripted"
    assert room.opened == 4  # the room once, then once per sentence, like presses of the talk button
    assert any("heard: what is due this week" in line for line in shown)  # shown to the reader
    kept = json.dumps(result).lower()
    assert not any(word in kept for word in ("dentist", "friday", "due this week"))  # and not kept


def test_reading_aloud_does_not_start_with_a_microphone_that_delivers_nothing():
    kit, _ = a_kit(Room(hiss=0.0))
    with pytest.raises(check.CheckFailed, match="delivered nothing"):
        check.check_read(kit, "", THREE)


# ---------- the command ----------


def test_nothing_listens_or_makes_sound_before_the_person_there_says_so():
    room = Room()
    kit, shown = a_kit(room)
    opened_when_asked = []
    kit.ask = lambda question: opened_when_asked.append(room.opened) or ""
    assert check.main(["mic", "--seconds", "2"], kit) == 0
    assert opened_when_asked == [0]  # asked once, before the microphone was opened
    assert shown[0].startswith("This listens with the microphone")

    kit, _ = a_kit(Room())
    kit.ask = lambda question: pytest.fail("asked although --yes was given")
    assert check.main(["mic", "--seconds", "2", "--yes"], kit) == 0


def test_listing_the_devices_needs_no_permission_and_names_the_defaults():
    kit, shown = a_kit(Room(), sound_system=lambda i, o: {"microphone": {"interface": "MME", "sample_rate": 48000, "delay_ms": [90, 180]}})
    kit.ask = lambda question: pytest.fail("listing devices makes no sound and opens nothing")
    assert check.main(["devices"], kit) == 0
    assert any("Room microphone" in line and "system default" in line for line in shown)
    assert any("through MME, 48000 Hz, expected delay 90 to 180 ms" in line for line in shown)


def test_the_results_file_grows_with_each_check_and_holds_no_names(tmp_path):
    out = tmp_path / "results" / "laptop.json"
    for arguments in (["devices"], ["mic", "--seconds", "2", "--yes"], ["echo", "--yes"]):
        kit, _ = a_kit(Room())
        assert check.main([*arguments, "--out", str(out)], kit) == 0
    kept = json.loads(out.read_text())
    assert [entry["check"] for entry in kept["checks"]] == ["devices", "mic", "echo"]
    assert set(kept["machine"]) == {"system", "processor", "python"} and all("at" in entry for entry in kept["checks"])
    assert "Room microphone" not in out.read_text() and "Room speaker" not in out.read_text()

    out.write_text("[1, 2, 3]")
    kit, shown = a_kit(Room())
    assert check.main(["devices", "--out", str(out)], kit) == 1
    assert out.read_text() == "[1, 2, 3]" and any("not a results file" in line for line in shown)  # a file of something else is left alone


def test_a_failure_is_an_exit_code_and_a_reason_not_a_crash():
    room = Room()
    room.fail_input = True
    kit, shown = a_kit(room)
    assert check.main(["mic", "--yes"], kit) == 1
    assert any("could not be used (PortAudioError)" in line and "Invalid sample rate" in line for line in shown)  # the sound system's own words

    kit, shown = a_kit(Room(hiss=0.0))
    assert check.main(["mic", "--yes"], kit) == 1
    assert any("Privacy & security" in line for line in shown)

    kit, _ = a_kit(Room(echo=0.0))
    assert check.main(["echo", "--yes"], kit) == 1


# ---------- the time to the first sound, out of the core's log ----------


def a_log(*turns) -> str:
    lines = ["2026-11-20T19:00:00.000Z Home Base 0.2.0 is running at http://localhost:7127"]
    for index, (transcript, first_text, sound) in enumerate(turns):
        lines.append(f"2026-11-20T19:01:{index:02d}.000Z Spoken turn: transcript after {transcript} ms, first text after {first_text} ms, first sound after {sound} ms.")
        lines.append("2026-11-20T19:01:59.000Z WARN Voice worker reported mic_unavailable.")
    return "\n".join(lines) + "\n"


def test_the_last_ten_spoken_exchanges_give_the_middle_the_ninetieth_and_the_slowest(tmp_path):
    log, out = tmp_path / "core.log", tmp_path / "audio.json"
    # A slow first exchange while every model loads and an odd one, then ten: 100, 200 ... 1000 ms to the first sound, in no order.
    log.write_text(a_log((900, 4000, 9000), (300, "?", 5000), *[(100 + 10 * n, 50 * n + 60, 100 * n) for n in (3, 1, 10, 2, 9, 4, 8, 5, 7, 6)]))
    kit, shown = a_kit(Room())
    kit.ask = lambda question: pytest.fail("reading a log needs nobody's permission: it opens no microphone and makes no sound")
    assert check.main(["turns", "--log", str(log), "--speaker-delay", "140", "--out", str(out)], kit) == 0

    kept = json.loads(out.read_text())["checks"][0]
    assert (kept["exchanges_in_the_log"], kept["counted"]) == (12, 10)  # the two before the last ten are left out
    assert kept["to_first_sound"] == {"median_ms": 550, "ninetieth_percentile_ms": 900, "slowest_ms": 1000}
    assert kept["to_first_sound_heard"] == {"median_ms": 690, "ninetieth_percentile_ms": 1040, "slowest_ms": 1140}  # the speakers' own delay on top
    assert kept["to_transcript"] == {"median_ms": 155, "ninetieth_percentile_ms": 190, "slowest_ms": 200}
    assert kept["to_first_text"] == {"median_ms": 335, "ninetieth_percentile_ms": 510, "slowest_ms": 560}
    assert any("middle value 550 ms, 90th percentile 900 ms, slowest 1000 ms" in line for line in shown)


def test_fewer_exchanges_than_asked_for_are_said_to_be_fewer_and_none_at_all_is_a_failure(tmp_path):
    log = tmp_path / "core.log"
    log.write_text(a_log((120, 300, 700), (130, "?", 900), (110, 310, 800)))
    kit, shown = a_kit(Room())
    assert check.main(["turns", "--log", str(log)], kit) == 0
    assert any("Only 3 exchanges were found; 10 were asked for" in line for line in shown)
    assert any("first sound handed to the speakers: middle value 800 ms, 90th percentile 900 ms, slowest 900 ms" in line for line in shown)
    assert any("model's first sentence: middle value 305 ms" in line for line in shown)  # the exchange with no first text is left out of that line only
    assert any("not in these figures" in line for line in shown)  # no delay of the speakers was given

    log.write_text("2026-11-20T19:00:00.000Z Home Base 0.2.0 is running\n")
    kit, shown = a_kit(Room())
    assert check.main(["turns", "--log", str(log)], kit) == 1 and any("no line of a spoken exchange" in line for line in shown)
    assert check.main(["turns"], kit) == 1  # no file named
    assert check.main(["turns", "--log", str(tmp_path / "missing.log")], kit) == 1


def test_the_line_this_reads_is_the_line_the_core_writes():
    source = Path(__file__).resolve().parents[3] / "apps" / "core" / "src" / "voice" / "service.ts"
    written = next(line for line in source.read_text(encoding="utf-8").splitlines() if "Spoken turn:" in line)
    template = written[written.index("`") + 1 : written.rindex("`")]
    assert check.TURN.search(re.sub(r"\$\{[^}]*\}", "250", template))  # with figures in every place
    assert check.TURN.search(template.replace('${timings.firstTextMs ?? "?"}', "?").replace("${timings.transcriptMs}", "1").replace("${timings.firstSoundMs}", "2"))  # and with no first text


# ---------- with the real models, still in the test's own room ----------


@pytest.mark.skipif(not (models_dir() / "tts" / "voices-v1.0.bin").exists(), reason="speech models are not installed")
def test_the_real_voice_through_a_room_is_understood_by_the_real_recogniser():
    from helios_voice.engines import KokoroTts, ParakeetStt, SileroVad

    room = Room(delay=0.15, echo=0.3)
    shown: list[str] = []
    kit = check.Kit(backend=room, make_stt=lambda: ParakeetStt("parakeet-unified"), make_tts=lambda: KokoroTts("int8"), make_vad=SileroVad, clock=room.clock, sleep=room.sleep, show=shown.append)
    result = check.check_echo(kit, stop_after=None)
    # The room's delay, plus the quiet start of the sentence itself: a listener waits for both.
    assert result["heard"] is True and 140 <= result["heard_after_ms"] <= 260
    assert result["own_words"] == 19 and result["own_words_recognised"] >= 17
    assert result["quiet_after_ms"] is not None and result["quiet_after_ms"] <= 400
