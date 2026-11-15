"""The worker's behaviour, with scripted engines and in-memory audio.
No model files and no audio hardware are needed."""

import io
import json
import time

import numpy as np
import pytest

from helios_voice.audio import SAMPLE_RATE, AudioUnavailable, MockAudioBackend, run_with_timeout
from helios_voice.engines import FakeStt, FakeTts, FakeWake, split_sentences
from helios_voice.protocol import Channel
from helios_voice.worker import Worker

SECOND = np.zeros(SAMPLE_RATE, dtype=np.float32)


class Rig:
    def __init__(self, stt_text="what is due this week", wake=False):
        self.out = io.StringIO()
        self.audio = MockAudioBackend()
        self.stt = FakeStt(stt_text)
        self.tts = FakeTts()
        self.wake = FakeWake()
        self.worker = Worker(Channel(self.out), self.audio, lambda: self.stt, lambda: self.tts, None, (lambda: self.wake) if wake else None)

    def events(self, type_=None):
        found = [json.loads(line) for line in self.out.getvalue().splitlines()]
        return [event for event in found if type_ is None or event["type"] == type_]

    def wait_for(self, type_, count=1, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if len(self.events(type_)) >= count:
                return self.events(type_)
            time.sleep(0.01)
        raise AssertionError(f"no {type_} event; got {[event['type'] for event in self.events()]}")

    def send(self, type_, **fields):
        self.worker.handle({"type": type_, **fields})


def test_push_to_talk_becomes_a_transcript():
    rig = Rig()
    rig.send("listen_start")
    assert rig.audio.input_open
    rig.audio.feed(np.tile(SECOND, 2))
    rig.send("listen_stop")
    transcript = rig.wait_for("transcript")[0]
    assert transcript["text"] == "what is due this week"
    assert transcript["audio_ms"] == 2000
    assert not rig.audio.input_open  # the microphone is closed when it is not needed
    states = [event["state"] for event in rig.wait_for("state", 3)]
    assert states == ["listening", "transcribing", "idle"]


def test_a_tap_that_captured_nothing_is_not_sent_to_the_recogniser():
    rig = Rig()
    rig.send("listen_start")
    rig.audio.feed(SECOND[:1600])  # a tenth of a second
    rig.send("listen_stop")
    assert rig.wait_for("transcript")[0]["text"] == ""
    assert rig.stt.heard == []


def test_cancel_throws_the_capture_away():
    rig = Rig()
    rig.send("listen_start")
    rig.audio.feed(SECOND)
    rig.send("listen_cancel")
    time.sleep(0.05)
    assert rig.events("transcript") == []
    assert rig.events("state")[-1]["state"] == "idle"


def test_speaking_sentence_by_sentence():
    rig = Rig()
    rig.send("speak", id="a1", text="First sentence. Second sentence.")
    rig.send("speak", id="a1", text="Third, which arrived later.")
    rig.send("speak_end", id="a1")
    finished = rig.wait_for("speech_finished")[0]
    assert finished == {"type": "speech_finished", "id": "a1", "interrupted": False}
    assert rig.tts.spoken == ["First sentence.", "Second sentence.", "Third, which arrived later."]
    assert len(rig.audio.played) == 3
    assert len(rig.events("speech_started")) == 1  # once per answer, not per sentence
    assert [event["state"] for event in rig.events("state")] == ["speaking", "idle"]
    assert split_sentences("One. Two? Three!") == ["One.", "Two?", "Three!"]


def test_speech_can_be_stopped_at_once():
    rig = Rig()
    rig.audio.play_seconds = 5.0  # a long sentence
    rig.send("speak", id="a1", text="A very long sentence. And another one.")
    rig.send("speak_end", id="a1")
    assert rig.audio.playing.wait(2.0)
    started = time.monotonic()
    rig.send("stop_speaking")
    finished = rig.wait_for("speech_finished")[0]
    assert finished["interrupted"] is True
    rig.wait_for("state", 2)
    assert rig.events("state")[-1]["state"] == "idle"
    assert time.monotonic() - started < 1.0  # not after the five seconds
    assert rig.audio.played == []  # nothing was played to the end
    assert rig.tts.spoken == ["A very long sentence."]  # and the rest was never synthesised


def test_pressing_talk_interrupts_helios():
    rig = Rig()
    rig.audio.play_seconds = 5.0
    rig.send("speak", id="a1", text="I was saying something long.")
    assert rig.audio.playing.wait(2.0)
    rig.send("listen_start")
    assert rig.wait_for("speech_finished")[0]["interrupted"] is True
    assert rig.audio.input_open


def test_a_missing_microphone_is_reported_and_survived():
    rig = Rig()
    rig.audio.fail_input = True
    rig.send("listen_start")
    assert rig.events("error")[0]["code"] == "mic_unavailable"
    assert rig.events("state") == []  # it never claimed to be listening
    # The device comes back: the next press simply works.
    rig.audio.fail_input = False
    rig.send("listen_start")
    rig.audio.feed(SECOND)
    rig.send("listen_stop")
    assert rig.wait_for("transcript")[0]["text"] == "what is due this week"


def test_a_broken_speaker_is_reported_and_survived():
    rig = Rig()
    rig.audio.fail_output = True
    rig.send("speak", id="a1", text="Nobody will hear this.")
    rig.send("speak_end", id="a1")
    assert rig.wait_for("error")[0]["code"] == "output_unavailable"
    assert rig.wait_for("speech_finished")[0]["interrupted"] is True
    rig.audio.fail_output = False
    rig.send("speak", id="a2", text="This one is heard.")
    rig.send("speak_end", id="a2")
    assert rig.wait_for("speech_finished", 2)[1] == {"type": "speech_finished", "id": "a2", "interrupted": False}


def test_the_wake_word_starts_listening_but_never_while_helios_speaks():
    rig = Rig(wake=True)
    rig.send("configure", config={"wake_enabled": True, "wake_threshold": 0.6, "guard_ms": 200})
    assert rig.audio.input_open  # wake mode keeps the microphone open

    # While speaking, even a certain detection is ignored.
    rig.audio.play_seconds = 0.3
    rig.send("speak", id="a1", text="Hey Helios is exactly what I am saying.")
    assert rig.audio.playing.wait(2.0)
    rig.wake.next_score = 0.99
    rig.audio.feed(SECOND[:1600])
    assert rig.events("wake_detected") == []
    rig.send("speak_end", id="a1")
    rig.wait_for("speech_finished")
    # And for the guard time just after.
    rig.wake.next_score = 0.99
    rig.audio.feed(SECOND[:1600])
    assert rig.events("wake_detected") == []

    time.sleep(0.25)
    rig.wake.next_score = 0.4  # below the threshold: not sure enough
    rig.audio.feed(SECOND[:1600])
    assert rig.events("wake_detected") == []
    rig.wake.next_score = 0.9
    rig.audio.feed(SECOND[:1600])
    assert rig.events("wake_detected")[0]["score"] == 0.9
    assert rig.events("state")[-1]["state"] == "listening"


def test_wake_mode_can_be_switched_off():
    rig = Rig(wake=True)
    rig.send("configure", config={"wake_enabled": True})
    rig.send("configure", config={"wake_enabled": False})
    assert not rig.audio.input_open
    rig.wake.next_score = 0.99
    rig.audio.feed(SECOND[:1600])
    assert rig.events("wake_detected") == []


def test_bad_input_does_not_stop_the_worker():
    rig = Rig()
    rig.worker.run(io.StringIO('not json\n{"type":"launch_missiles"}\n[1,2]\n{"type":"ping"}\n'))
    kinds = [event["type"] for event in rig.events()]
    assert kinds.count("error") == 3
    assert kinds[-1] == "pong"
    assert all("missiles" not in json.dumps(event) for event in rig.events())  # input is not echoed back


def test_the_worker_stops_when_the_core_goes_away():
    rig = Rig(wake=True)
    rig.worker.run(io.StringIO('{"type":"configure","config":{"wake_enabled":true}}\n'))  # then the pipe closes
    assert not rig.audio.input_open
    assert rig.worker._closing


def test_devices_are_listed():
    rig = Rig()
    rig.send("devices")
    devices = rig.events("devices")[0]
    assert devices["inputs"][0]["name"] == "Mock microphone"
    assert devices["outputs"][0]["default"] is True


def test_no_words_reach_the_log(capsys):
    rig = Rig(stt_text="my private sentence")
    rig.send("listen_start")
    rig.audio.feed(np.tile(SECOND, 2))
    rig.send("listen_stop")
    rig.wait_for("transcript")
    rig.send("speak", id="a1", text="A confidential answer.")
    rig.send("speak_end", id="a1")
    rig.wait_for("speech_finished")
    logged = capsys.readouterr().err
    assert "transcribed 2000 ms" in logged
    assert "private" not in logged and "confidential" not in logged


def test_an_audio_system_that_does_not_answer_cannot_freeze_the_worker():
    closed = []

    def waiting_for_permission():
        time.sleep(0.3)  # the system dialog is still open
        return "a stream opened too late"

    started = time.monotonic()
    with pytest.raises(AudioUnavailable):
        run_with_timeout(waiting_for_permission, 0.05, closed.append)
    assert time.monotonic() - started < 0.2  # gave up quickly
    time.sleep(0.4)
    assert closed == ["a stream opened too late"]  # and what opened afterwards was closed again
    assert run_with_timeout(lambda: "in time", 1.0) == "in time"
