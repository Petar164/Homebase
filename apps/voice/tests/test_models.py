"""The model list, the download command and the check before a model is
loaded. A small web server on this machine stands in for the release pages,
so nothing here reaches the internet. Only the last test reads the real
model files, and it is skipped where they are not installed."""

import hashlib
import http.server
import io
import json
import tarfile
import threading
import time

import numpy as np
import pytest

from helios_voice import models
from helios_voice.audio import SAMPLE_RATE, MockAudioBackend
from helios_voice.engines import STT_MODELS, TTS_MODELS, FakeTts
from helios_voice.models import ModelUnavailable, checked, download, load_list, main, models_dir, report, state_of_set
from helios_voice.protocol import Channel
from helios_voice.worker import Worker


class Site:
    """A web server on 127.0.0.1 that serves bytes from memory and notes what was asked for."""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.moved: dict[str, str] = {}  # addresses that answer with a redirect, as release pages do
        self.cut: dict[str, int] = {}  # addresses whose answer breaks off after this many bytes
        self.asked: list[str] = []
        site = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                site.asked.append(self.path)
                if self.path in site.moved:
                    self.send_response(302)
                    self.send_header("Location", site.moved[self.path])
                    self.end_headers()
                    return
                body = site.files.get(self.path)
                if body is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body[: site.cut.get(self.path, len(body))])

            def log_message(self, *_args) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, name: str) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/{name}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def site():
    server = Site()
    yield server
    server.close()


@pytest.fixture
def root(tmp_path, monkeypatch):
    """An empty models folder for this test alone."""
    folder = tmp_path / "models"
    monkeypatch.setenv("HOMEBASE_MODELS_DIR", str(folder))
    return folder


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def archive_of(members: list[tuple[str, bytes]], links: list[tarfile.TarInfo] = []) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:bz2") as tar:
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for link in links:
            tar.addfile(link)
    return buffer.getvalue()


def plain(site: Site, name: str, data: bytes, to: str) -> dict:
    """Serves `data` and returns the list entry that records exactly that file."""
    site.files[f"/{name}"] = data
    return {"url": site.url(name), "bytes": len(data), "sha256": sha(data), "to": to}


def packed(site: Site, name: str, served: bytes, into: str, members: dict[str, bytes]) -> dict:
    """Serves an archive and returns the entry that records it and the members to take out."""
    site.files[f"/{name}"] = served
    return {"url": site.url(name), "bytes": len(served), "sha256": sha(served), "unpack_into": into, "members": {member: {"bytes": len(data), "sha256": sha(data)} for member, data in members.items()}}


def listing(tmp_path, sources: dict) -> models.ModelList:
    path = tmp_path / "list.json"
    path.write_text(json.dumps({"sets": {name: {"about": name, "default": True, "sources": [name]} for name in sources}, "sources": sources}))
    return load_list(path, allow_http=True)


def files_in(folder) -> list[str]:
    return sorted(path.relative_to(folder).as_posix() for path in folder.rglob("*") if path.is_file()) if folder.exists() else []


VAD = b"V" * 3000
MEMBERS = {"recogniser/encoder.onnx": b"E" * 5000, "recogniser/tokens.txt": b"a 1\nb 2\n"}


def test_files_and_archive_members_are_downloaded_into_place(tmp_path, site, root):
    vad = plain(site, "vad.onnx", VAD, "vad/vad.onnx")
    vad["url"] = site.url("release/vad.onnx")
    site.moved["/release/vad.onnx"] = "/vad.onnx"  # the listed address redirects to where the file is
    archive = archive_of([*MEMBERS.items(), ("recogniser/README.md", b"not on the list")])
    wanted = listing(tmp_path, {"vad": vad, "recogniser": packed(site, "recogniser.tar.bz2", archive, "stt", MEMBERS)})
    (root / ".downloads").mkdir(parents=True)
    (root / ".downloads" / "left-by-a-run-that-was-killed.part").write_bytes(b"half a file")

    assert download(list(wanted.sets), root, lambda text: None) is True
    assert (root / "vad" / "vad.onnx").read_bytes() == VAD
    assert (root / "stt" / "recogniser" / "encoder.onnx").read_bytes() == MEMBERS["recogniser/encoder.onnx"]
    # Only what the list names is on disk: no archive, no side folder, no file the list does not know.
    assert files_in(root) == ["stt/recogniser/encoder.onnx", "stt/recogniser/tokens.txt", "vad/vad.onnx"]
    assert not (root / ".downloads").exists()
    assert report(wanted, root, deep=True, say=lambda text: None) is True


@pytest.mark.parametrize(
    "problem, reason",
    [
        ("other content", "does not have the SHA-256 in the list"),
        ("other size", "now offers 4,004 bytes, not the 4,000 in the list"),  # known before a byte is fetched
        ("cut short", "stopped at 1,000 of 4,000 bytes"),
        ("gone", "404"),
    ],
)
def test_a_download_that_is_not_the_recorded_file_is_refused(problem, reason, tmp_path, site, root):
    entry = plain(site, "voice.onnx", b"M" * 4000, "tts/voice.onnx")
    if problem == "other content":
        site.files["/voice.onnx"] = b"X" * 4000  # the same size: only the hash can tell
    if problem == "other size":
        site.files["/voice.onnx"] = b"M" * 4000 + b"more"
    if problem == "cut short":
        site.cut["/voice.onnx"] = 1000
    if problem == "gone":
        del site.files["/voice.onnx"]
    said: list[str] = []

    assert download(list(listing(tmp_path, {"voice": entry}).sets), root, said.append) is False
    assert "NOT installed" in said[-1] and reason in said[-1]
    assert files_in(root) == []  # neither the file nor a half-finished download
    assert not (root / ".downloads").exists()


def test_an_archive_cannot_put_a_file_anywhere_but_the_listed_places(tmp_path, site, root):
    # The list records this archive, so it passes the first check. What is in it still decides nothing.
    hostile = archive_of([*MEMBERS.items(), ("../escaped.txt", b"out"), ("/absolute.txt", b"abs"), ("recogniser/extra.bin", b"extra")])
    wanted = listing(tmp_path, {"recogniser": packed(site, "recogniser.tar.bz2", hostile, "stt", MEMBERS)})

    assert download(list(wanted.sets), root, lambda text: None) is True
    assert files_in(tmp_path) == ["list.json", "models/stt/recogniser/encoder.onnx", "models/stt/recogniser/tokens.txt"]


@pytest.mark.parametrize("problem", ["a link", "a second copy", "missing", "other content"])
def test_an_archive_member_that_is_not_the_recorded_file_is_refused(problem, tmp_path, site, root):
    members, links = list(MEMBERS.items()), []
    if problem == "a link":
        link = tarfile.TarInfo("recogniser/encoder.onnx")
        link.type, link.linkname = tarfile.SYMTYPE, "/etc/hosts"
        members, links = members[1:], [link]
    if problem == "a second copy":
        members.append(("recogniser/encoder.onnx", b"Z" * 5000))  # the later copy would win in an ordinary unpack
    if problem == "missing":
        members = members[1:]
    if problem == "other content":
        members[0] = ("recogniser/encoder.onnx", b"Z" * 5000)
    wanted = listing(tmp_path, {"recogniser": packed(site, "recogniser.tar.bz2", archive_of(members, links), "stt", MEMBERS)})
    said: list[str] = []

    assert download(list(wanted.sets), root, said.append) is False
    assert "NOT installed" in said[-1]
    assert files_in(root) == []  # not even the members that were fine


def test_what_is_installed_and_intact_is_not_downloaded_again(tmp_path, site, root):
    wanted = listing(tmp_path, {"vad": plain(site, "vad.onnx", VAD, "vad/vad.onnx")})
    assert download(list(wanted.sets), root, lambda text: None) is True
    asked = len(site.asked)
    said: list[str] = []

    assert download(list(wanted.sets), root, said.append) is True
    assert len(site.asked) == asked
    assert said == ["vad: already installed"]


def test_a_changed_file_is_found_by_verify_and_replaced_by_download(tmp_path, site, root):
    wanted = listing(tmp_path, {"vad": plain(site, "vad.onnx", VAD, "vad/vad.onnx")})
    download(list(wanted.sets), root, lambda text: None)
    (root / "vad" / "vad.onnx").write_bytes(b"W" * 3000)  # the same size, other content

    assert state_of_set(wanted.sets[0], root, deep=False) == ("installed", [])  # a look at the size is fooled
    assert state_of_set(wanted.sets[0], root) == ("damaged", ["vad/vad.onnx"])
    lines: list[str] = []
    assert report(wanted, root, deep=True, say=lines.append) is False
    assert any("not the listed file: vad/vad.onnx" in line for line in lines)

    assert download(list(wanted.sets), root, lambda text: None) is True
    assert (root / "vad" / "vad.onnx").read_bytes() == VAD


def test_a_file_that_is_briefly_held_by_another_program_is_still_installed(tmp_path, site, root, monkeypatch):
    # What a virus scanner on Windows does to a file that was just written.
    wanted = listing(tmp_path, {"vad": plain(site, "vad.onnx", VAD, "vad/vad.onnx")})
    replace, refusals = models.os.replace, []

    def held_twice(staged, place):
        if len(refusals) < 2:
            refusals.append(place)
            raise PermissionError("the file is in use")
        replace(staged, place)

    monkeypatch.setattr(models.os, "replace", held_twice)
    monkeypatch.setattr(models.time, "sleep", lambda seconds: None)
    assert download(list(wanted.sets), root, lambda text: None) is True
    assert len(refusals) == 2 and (root / "vad" / "vad.onnx").read_bytes() == VAD

    # A file that stays held (a running worker has it open) is reported, and nothing is left behind.
    def held(staged, place):
        raise PermissionError("the file is in use")

    (root / "vad" / "vad.onnx").write_bytes(b"W" * 3000)
    monkeypatch.setattr(models.os, "replace", held)
    said: list[str] = []
    assert download(list(wanted.sets), root, said.append) is False
    assert "NOT installed: could not be installed (the file is in use)" in said[-1]
    assert files_in(root) == ["vad/vad.onnx"]


def test_a_download_is_not_started_without_room_for_it(tmp_path, site, root, monkeypatch):
    wanted = listing(tmp_path, {"vad": plain(site, "vad.onnx", VAD, "vad/vad.onnx")})
    monkeypatch.setattr(models.shutil, "disk_usage", lambda path: type("Usage", (), {"free": 1000})())
    said: list[str] = []

    assert download(list(wanted.sets), root, said.append) is False
    assert "not enough free disk space" in said[-1]
    assert site.asked == []


def test_a_model_file_is_only_loaded_when_it_is_the_listed_one(tmp_path, site, root):
    wanted = listing(tmp_path, {"vad": plain(site, "vad.onnx", VAD, "vad/vad.onnx")})
    path = root / "vad" / "vad.onnx"
    with pytest.raises(ModelUnavailable, match="vad/vad.onnx is not installed. Fetch it with: .* download vad"):
        checked(path, wanted)

    download(list(wanted.sets), root, lambda text: None)
    assert checked(path, wanted) == str(path)

    path.write_bytes(b"W" * 3000)
    with pytest.raises(ModelUnavailable, match="checksum differs"):
        checked(path, wanted)

    # A file the list does not know, such as a wake model trained later, has nothing to be compared with.
    own = root / "wake" / "trained_later.onnx"
    own.parent.mkdir()
    own.write_bytes(b"the owner's own")
    assert checked(own, wanted) == str(own)
    with pytest.raises(ModelUnavailable, match="wake/absent.onnx is not installed$"):
        checked(root / "wake" / "absent.onnx", wanted)


PARAKEET_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
ENGINE_FILES = {
    "parakeet-unified": [f"stt/{STT_MODELS['parakeet-unified']}/{name}" for name in PARAKEET_FILES],
    "parakeet-tdt-v2": [f"stt/{STT_MODELS['parakeet-tdt-v2']}/{name}" for name in PARAKEET_FILES],
    "kokoro-int8": ["tts/kokoro-v1.0.int8.onnx", "tts/voices-v1.0.bin"],
    "kokoro-full": ["tts/kokoro-v1.0.onnx", "tts/voices-v1.0.bin"],
    "silero-vad": ["vad/silero_vad.onnx"],
    "wake-word": ["wake/hey_jarvis_v0.1.onnx", "wake/melspectrogram.onnx", "wake/embedding_model.onnx"],
}


@pytest.mark.parametrize("engine", sorted(ENGINE_FILES))
def test_every_file_an_engine_loads_is_compared_with_the_list_first(engine, root, monkeypatch):
    """The real engine classes, with the speech libraries replaced by a
    recorder and small stand-in files in place of the models."""
    import kokoro_onnx
    import sherpa_onnx

    from helios_voice import engines

    given: list[str] = []  # the paths that reached a speech library
    monkeypatch.setattr(sherpa_onnx.OfflineRecognizer, "from_transducer", lambda **options: given.extend(options[key] for key in ("encoder", "decoder", "joiner", "tokens")))
    monkeypatch.setattr(sherpa_onnx, "VoiceActivityDetector", lambda config, buffer_size_in_seconds: given.append(config.silero_vad.model))
    monkeypatch.setattr(kokoro_onnx, "Kokoro", lambda model, voices: given.extend([model, voices]))
    if engine == "wake-word":
        wake = pytest.importorskip("openwakeword.model")
        monkeypatch.setattr(wake, "Model", lambda **options: given.extend([*options["wakeword_models"], options["melspec_model_path"], options["embedding_model_path"]]))
    load = {
        "parakeet-unified": lambda: engines.ParakeetStt("parakeet-unified"),
        "parakeet-tdt-v2": lambda: engines.ParakeetStt("parakeet-tdt-v2"),
        "kokoro-int8": lambda: engines.KokoroTts("int8"),
        "kokoro-full": lambda: engines.KokoroTts("full"),
        "silero-vad": engines.SileroVad,
        "wake-word": lambda: engines.OpenWakeWord("hey_jarvis_v0.1.onnx"),
    }[engine]

    # The shipped list's own paths, each recorded with the hash of a small stand-in file.
    stand_ins = {file.path: f"stand-in for {file.path}".encode() for file in models.shipped().files().values()}
    recorded = tuple(models.ModelFile(path, len(data), sha(data)) for path, data in stand_ins.items())
    monkeypatch.setattr(models, "shipped", lambda: models.ModelList((models.ModelSet("all", "", True, (models.Source("all", "https://example.org/all", 1, "0" * 64, recorded, False),)),)))
    expected = ENGINE_FILES[engine]

    with pytest.raises(ModelUnavailable, match="is not installed"):
        load()  # an empty models folder
    for path, data in stand_ins.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_bytes(data)
    load()
    assert sorted(given) == sorted(str(root / path) for path in expected)  # exactly the listed files reach the library

    for path in expected:
        given.clear()
        (root / path).write_bytes(b"something else")
        with pytest.raises(ModelUnavailable, match=f"{path} is not the file in the model list"):
            load()
        assert given == []  # the library was never handed anything
        (root / path).write_bytes(stand_ins[path])


def test_the_worker_says_which_model_file_is_wrong_and_goes_on():
    def recogniser():
        raise ModelUnavailable("stt/recogniser/encoder.onnx is not the file in the model list")

    out, audio = io.StringIO(), MockAudioBackend()
    worker = Worker(Channel(out), audio, recogniser, FakeTts, None, None)
    worker.handle({"type": "listen_start"})
    audio.feed(np.zeros(SAMPLE_RATE, dtype=np.float32))
    worker.handle({"type": "listen_stop"})

    def events(kind):
        return [event for event in map(json.loads, out.getvalue().splitlines()) if event["type"] == kind]

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and not events("transcript"):
        time.sleep(0.01)
    assert events("error") == [{"type": "error", "code": "stt_failed", "message": "stt/recogniser/encoder.onnx is not the file in the model list"}]
    assert events("transcript")[0]["text"] == ""
    worker.handle({"type": "ping"})
    assert events("pong")  # still answering


@pytest.mark.parametrize(
    "change",
    [
        {"to": "../outside.onnx"},
        {"to": "/absolute.onnx"},
        {"to": "C:\\elsewhere.onnx"},
        {"to": "tts/../../outside.onnx"},
        {"url": "http://example.org/voice.onnx"},
        {"url": "file:///etc/hosts"},
        {"sha256": "abc"},
        {"bytes": 0},
        {"members": {"../outside.onnx": {"bytes": 1, "sha256": "0" * 64}}, "unpack_into": "stt"},
    ],
)
def test_a_list_that_could_write_elsewhere_or_fetch_unprotected_is_refused(change, tmp_path):
    entry = {"url": "https://example.org/voice.onnx", "bytes": 10, "sha256": "0" * 64, "to": "tts/voice.onnx", **change}
    path = tmp_path / "list.json"
    path.write_text(json.dumps({"sets": {"voice": {"about": "", "sources": ["voice"]}}, "sources": {"voice": entry}}))
    with pytest.raises(ValueError):
        load_list(path)


def test_the_list_that_ships_names_every_file_the_engines_load():
    shipped = models.shipped()
    listed = shipped.files()
    loaded = [f"stt/{folder}/{name}" for folder in STT_MODELS.values() for name in ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")]
    loaded += [f"tts/{name}" for name in TTS_MODELS.values()]
    loaded += ["tts/voices-v1.0.bin", "vad/silero_vad.onnx", "wake/melspectrogram.onnx", "wake/embedding_model.onnx", "wake/hey_jarvis_v0.1.onnx"]
    assert [path for path in loaded if path.casefold() not in listed] == []

    # What HELIOS needs with its default settings is fetched without naming anything.
    by_default = {file.path for model_set in shipped.sets if model_set.default for file in model_set.files()}
    needed = [path for path in loaded if path.startswith(("stt/", "vad/"))] + ["tts/kokoro-v1.0.int8.onnx", "tts/voices-v1.0.bin"]
    assert [path for path in needed if path not in by_default] == []

    # Every address is a release of one of the three projects the models come from.
    projects = ("k2-fsa/sherpa-onnx", "thewh1teagle/kokoro-onnx", "dscripka/openWakeWord")
    sources = {source.name: source for model_set in shipped.sets for source in model_set.sources}
    assert all(source.url.startswith(tuple(f"https://github.com/{project}/releases/download/" for project in projects)) for source in sources.values())


def test_the_command_fails_while_something_helios_needs_is_missing(root, capsys):
    assert main(["status"]) == 1
    printed = capsys.readouterr().out
    assert "not installed" in printed and "helios_voice.models download" in printed
    assert main(["verify"]) == 1
    assert main(["download", "no-such-set"]) == 2
    assert not root.exists()  # looking and a refused request create nothing


@pytest.mark.skipif(not (models_dir() / "tts" / "voices-v1.0.bin").exists(), reason="speech models are not installed")
def test_the_models_on_this_machine_are_the_listed_ones():
    states = {model_set.name: state_of_set(model_set, models_dir()) for model_set in models.shipped().sets}
    assert {name: changed for name, (state, changed) in states.items() if state == "damaged"} == {}
    assert [model_set.name for model_set in models.shipped().sets if model_set.default and states[model_set.name][0] != "installed"] == []
