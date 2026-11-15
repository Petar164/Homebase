"""The speech model files: where they come from, and whether the ones on
this machine are the ones that were chosen.

    uv run python -m helios_voice.models                  what is installed
    uv run python -m helios_voice.models download         fetch what HELIOS needs and does not have
    uv run python -m helios_voice.models download --all   also the optional sets
    uv run python -m helios_voice.models download kokoro-full wake-word
    uv run python -m helios_voice.models verify           re-read every installed file and compare

The list of files is `models.json`, next to this module. For every file it
records the address, the size and the SHA-256. Three rules follow from it:

1. Nothing reaches the models folder before it has been compared with the
   list. A download is written to a side folder and hashed on the way; only
   a file with the recorded size and hash is moved into place. Anything
   else is deleted and reported.
2. An archive is opened only after its own hash matched. Only the members
   named in the list are taken out of it, each to a path this program
   chose, and each compared with its own hash before it is moved.
3. The worker compares a model file with the list every time it loads one
   (`checked`, used by engines.py), so a file that changed after the
   download is not loaded either.

Changing a model therefore means changing the list, in a commit. The
addresses are release pages whose owners can replace a file under the same
name. When that happens the download is refused here, which is the point.

This module uses only the standard library, so the command works before
any speech package is installed.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import http.client
import json
import os
import posixpath
import re
import shutil
import sys
import tarfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable

LIST_FILE = Path(__file__).with_name("models.json")
COMMAND = "uv run python -m helios_voice.models"
CHUNK = 1 << 20
#: A connection that sends nothing for this many seconds is given up on.
TIMEOUT_S = 60
#: Free disk space kept in reserve on top of what a download needs.
SPARE_BYTES = 64 * 1024 * 1024


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


class ModelUnavailable(Exception):
    """A model file is missing, or is not the file in the list. The message
    names the file and what to run, and nothing else, so it is safe to log
    and to show."""


class DownloadFailed(Exception):
    """A download was refused or did not finish. Nothing was installed from it."""


# ---------- the list ----------


@dataclass(frozen=True)
class ModelFile:
    #: Where the file lives, relative to the models folder, with forward slashes.
    path: str
    bytes: int
    sha256: str
    #: Its name inside the archive, when it comes out of one.
    member: str | None = None


@dataclass(frozen=True)
class Source:
    """One download: a model file itself, or a tar archive that holds several."""

    name: str
    url: str
    bytes: int
    sha256: str
    files: tuple[ModelFile, ...]
    archive: bool


@dataclass(frozen=True)
class ModelSet:
    """What the owner picks by name: the files one engine needs."""

    name: str
    about: str
    #: True when HELIOS needs it with the default settings.
    default: bool
    sources: tuple[Source, ...]

    def files(self) -> list[ModelFile]:
        return [file for source in self.sources for file in source.files]


@dataclass(frozen=True)
class ModelList:
    sets: tuple[ModelSet, ...]

    def files(self) -> dict[str, ModelFile]:
        """Every listed file by its path. Keys are lower-cased, because the
        file systems of Windows and macOS do not tell upper from lower case."""
        return {file.path.casefold(): file for model_set in self.sets for file in model_set.files()}

    def set_of(self, file: ModelFile) -> str:
        """The set to ask for to get this file: one HELIOS needs, if it is in several."""
        holding = [model_set for model_set in self.sets if file in model_set.files()]
        return next((model_set.name for model_set in holding if model_set.default), holding[0].name)


_SHA256 = re.compile(r"[0-9a-f]{64}")


def _relative(path: object, what: str) -> str:
    """A path that stays inside the folder it is joined to, or an error."""
    parts = PurePosixPath(path).parts if isinstance(path, str) else ()
    if not parts or "\\" in path or ":" in path or path.startswith("/") or any(part in ("..", ".") for part in parts) or "/".join(parts) != path:
        raise ValueError(f"{what}: {path!r} is not a plain relative path")
    return path


def _size_and_hash(entry: dict, what: str) -> tuple[int, str]:
    size, digest = entry.get("bytes"), entry.get("sha256")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise ValueError(f"{what}: bytes must be a positive whole number")
    if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
        raise ValueError(f"{what}: sha256 must be 64 lower-case hexadecimal characters")
    return size, digest


def load_list(path: Path = LIST_FILE, allow_http: bool = False) -> ModelList:
    """Reads and checks a list. `allow_http` exists for the tests, which
    serve their files from this machine; the real list is https only."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    sources: dict[str, Source] = {}
    taken: dict[str, str] = {}
    for name, entry in raw["sources"].items():
        url = entry.get("url")
        if not isinstance(url, str) or not url.startswith(("https://", "http://") if allow_http else "https://"):
            raise ValueError(f"{name}: the address must start with https://")
        size, digest = _size_and_hash(entry, name)
        if "members" in entry:
            into = _relative(entry.get("unpack_into"), name)
            files = tuple(
                ModelFile(f"{into}/{_relative(member, name)}", *_size_and_hash(recorded, f"{name}: {member}"), member)
                for member, recorded in entry["members"].items()
            )
            if not files:
                raise ValueError(f"{name}: an archive must name the members to take out of it")
        else:
            files = (ModelFile(_relative(entry.get("to"), name), size, digest),)
        for file in files:
            if file.path.casefold() in taken:
                raise ValueError(f"{file.path} is listed twice ({taken[file.path.casefold()]} and {name})")
            taken[file.path.casefold()] = name
        sources[name] = Source(name, url, size, digest, files, archive="members" in entry)
    sets = []
    for name, entry in raw["sets"].items():
        unknown = [source for source in entry["sources"] if source not in sources]
        if unknown or not entry["sources"]:
            raise ValueError(f"{name}: unknown or missing sources {unknown}")
        sets.append(ModelSet(name, str(entry["about"]), entry.get("default") is True, tuple(sources[source] for source in entry["sources"])))
    return ModelList(tuple(sets))


@functools.cache
def shipped() -> ModelList:
    """The list that comes with this code."""
    return load_list()


# ---------- comparing what is on disk with the list ----------


def sha256_of(path: Path) -> str:
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def place_of(file: ModelFile, root: Path) -> Path:
    return root.joinpath(*PurePosixPath(file.path).parts)


def state_of(file: ModelFile, root: Path, deep: bool = True) -> str:
    """ "ok", "missing" or "changed". Without `deep` only the size is
    compared, which takes no time; with it the whole file is hashed."""
    path = place_of(file, root)
    if not path.is_file():
        return "missing"
    if path.stat().st_size != file.bytes:
        return "changed"
    return "ok" if not deep or sha256_of(path) == file.sha256 else "changed"


def state_of_set(model_set: ModelSet, root: Path, deep: bool = True) -> tuple[str, list[str]]:
    """ "installed", "not installed" or "damaged", and the files that are not the listed ones."""
    states = {file.path: state_of(file, root, deep) for file in model_set.files()}
    changed = sorted(path for path, state in states.items() if state == "changed")
    if changed:
        return "damaged", changed
    return ("installed" if all(state == "ok" for state in states.values()) else "not installed"), []


def checked(path: Path, models: ModelList | None = None) -> str:
    """For the engines: the path as text, once the file is known to be the
    one in the list. Raises ModelUnavailable when it is missing or differs.

    A file that the list does not know (a wake model the owner trained, for
    example) has nothing to be compared with and is passed through."""
    path, models = Path(path), models or shipped()
    try:
        # Links are deliberately not followed here: what counts is the place
        # in the models folder, whatever that place points to.
        name = Path(os.path.abspath(path)).relative_to(os.path.abspath(models_dir())).as_posix()
    except ValueError:
        name = None
    listed = models.files().get(name.casefold()) if name else None
    fix = f"{COMMAND} download {models.set_of(listed)}" if listed else ""
    if not path.is_file():
        raise ModelUnavailable(f"{name or path.name} is not installed" + (f". Fetch it with: {fix}" if listed else ""))
    if listed is not None and (path.stat().st_size != listed.bytes or sha256_of(path) != listed.sha256):
        raise ModelUnavailable(f"{name} is not the file in the model list (its checksum differs). Replace it with: {fix}")
    return str(path)


# ---------- downloading ----------


def megabytes(count: int) -> str:
    return f"{count / 1024 / 1024:,.1f} MB"


def fetch(source: Source, part: Path, progress: Callable[[int], None] = lambda done: None) -> None:
    """Downloads `source` to `part`. The file is left there only when its
    size and SHA-256 are the recorded ones; otherwise it is deleted."""
    digest, done = hashlib.sha256(), 0
    try:
        with urllib.request.urlopen(source.url, timeout=TIMEOUT_S) as response, open(part, "wb") as out:
            declared = response.headers.get("Content-Length")
            if declared is not None and declared.isdigit() and int(declared) != source.bytes:
                raise DownloadFailed(f"the address now offers {int(declared):,} bytes, not the {source.bytes:,} in the list: the file there was replaced")
            while chunk := response.read(CHUNK):
                done += len(chunk)
                if done > source.bytes:
                    raise DownloadFailed(f"the address sent more than the {source.bytes:,} bytes in the list")
                digest.update(chunk)
                out.write(chunk)
                progress(done)
        if done != source.bytes:
            raise DownloadFailed(f"the download stopped at {done:,} of {source.bytes:,} bytes")
        if digest.hexdigest() != source.sha256:
            raise DownloadFailed("the downloaded file does not have the SHA-256 in the list: it is not the file that was chosen")
    except (OSError, http.client.HTTPException) as error:
        part.unlink(missing_ok=True)
        raise DownloadFailed(f"the download did not finish ({error})") from error
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def unpack(source: Source, archive: Path, staging: Path) -> list[tuple[Path, ModelFile]]:
    """Takes the listed members out of a verified archive into `staging`,
    under names chosen here, and compares each with its own hash. Nothing in
    the archive decides where a file goes, and a member that is not on the
    list is never written."""
    wanted = {file.member: file for file in source.files}
    staged: dict[str, tuple[Path, ModelFile]] = {}
    staging.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:*") as tar:
        for entry in tar:
            member = posixpath.normpath(entry.name)
            file = wanted.get(member)
            if file is None:
                continue
            if member in staged or not entry.isreg() or entry.size != file.bytes:
                raise DownloadFailed(f"{member} in the archive is not the file in the list")
            target = staging / str(len(staged))
            digest = hashlib.sha256()
            with tar.extractfile(entry) as stream, open(target, "wb") as out:
                while chunk := stream.read(CHUNK):
                    digest.update(chunk)
                    out.write(chunk)
            if digest.hexdigest() != file.sha256:
                raise DownloadFailed(f"{member} in the archive does not have the SHA-256 in the list")
            staged[member] = (target, file)
    absent = sorted(set(wanted) - set(staged))
    if absent:
        raise DownloadFailed(f"the archive does not contain {', '.join(absent)}")
    return list(staged.values())


def _move(staged: Path, place: Path, tries: int = 6, pause_s: float = 0.5) -> None:
    """Moves a verified file to its place, replacing what is there. On
    Windows a file that was just written can be held for a moment by a
    virus scanner, which shows up as a refused move; that is tried again a
    few times before giving up. (Written for Windows, not yet run there.)"""
    for attempt in range(tries):
        try:
            os.replace(staged, place)
            return
        except PermissionError:
            if attempt == tries - 1:
                raise
            time.sleep(pause_s)


def install(source: Source, root: Path, progress: Callable[[int], None] = lambda done: None, say: Callable[[str], None] = lambda text: None) -> None:
    """Downloads one source and puts its files in place, or raises
    DownloadFailed. Every file that reaches its place has been compared
    with the list first. The side folder belongs to this function alone: it
    is emptied before (a run that was killed may have left something) and
    removed afterwards."""
    side = root / ".downloads"
    part, staging = side / f"{source.name}.part", side / f"{source.name}.unpacked"
    try:
        shutil.rmtree(side, ignore_errors=True)
        side.mkdir(parents=True, exist_ok=True)
        needed = source.bytes + (sum(file.bytes for file in source.files) if source.archive else 0) + SPARE_BYTES
        free = shutil.disk_usage(root).free
        if free < needed:
            raise DownloadFailed(f"not enough free disk space: {megabytes(needed)} needed, {megabytes(free)} free")
        fetch(source, part, progress)
        if source.archive:
            say(f"unpacking {len(source.files)} files")
            ready = unpack(source, part, staging)
        else:
            ready = [(part, source.files[0])]
        for staged, file in ready:
            place = place_of(file, root)
            place.parent.mkdir(parents=True, exist_ok=True)
            _move(staged, place)
    except (OSError, EOFError, tarfile.TarError) as error:
        # A full disk, a file held open by a running worker, a broken archive.
        raise DownloadFailed(f"could not be installed ({error})") from error
    finally:
        shutil.rmtree(side, ignore_errors=True)


def download(sets: list[ModelSet], root: Path, say: Callable[[str], None] = print, progress_for: Callable[[Source], Callable[[int], None]] | None = None) -> bool:
    """Brings every file of `sets` into place. What is already there and
    intact is left alone; what is missing or damaged is fetched. Returns
    True when all of it is now installed."""
    complete, handled = True, set()
    for model_set in sets:
        for source in model_set.sources:
            if source.name in handled:  # one download can belong to two sets
                continue
            handled.add(source.name)
            if all(state_of(file, root) == "ok" for file in source.files):
                say(f"{source.name}: already installed")
                continue
            say(f"{source.name}: downloading {megabytes(source.bytes)} from {source.url}")
            try:
                install(source, root, progress_for(source) if progress_for else lambda done: None, lambda text: say(f"  {text}"))
                say("  installed")
            except DownloadFailed as error:
                complete = False
                say(f"  NOT installed: {error}")
    return complete


# ---------- the command ----------


def report(models: ModelList, root: Path, deep: bool, say: Callable[[str], None] = print) -> bool:
    """Prints one line per set. Returns True when everything HELIOS needs is
    installed and nothing that is installed differs from the list."""
    say(f"Models folder: {root}\n")
    width = max(len(model_set.name) for model_set in models.sets) + 2
    missing, damaged = [], []
    for model_set in models.sets:
        state, changed = state_of_set(model_set, root, deep)
        about = model_set.about if model_set.default else f"optional: {model_set.about}"
        if state == "not installed":
            pending = sum(source.bytes for source in model_set.sources if any(state_of(file, root, deep=False) != "ok" for file in source.files))
            about += f" ({megabytes(pending)} to download)"
            if model_set.default:
                missing.append(model_set.name)
        say(f"  {model_set.name:<{width}}{state.upper() if changed else state:<15}{about}")
        for path in changed:
            say(f"  {'':<{width}}not the listed file: {path}")
        if changed:
            damaged.append(model_set.name)
    say("")
    if damaged:
        say(f"Some files are not the ones in the model list. Replace them with: {COMMAND} download {' '.join(damaged)}")
    if missing:
        say(f"Not everything HELIOS needs is here. Fetch it with: {COMMAND} download")
    if not damaged and not missing:
        say("Everything HELIOS needs is installed" + (", and every installed file matches the model list." if deep else f". ({COMMAND} verify re-reads the files.)"))
    return not damaged and not missing


def _say(text: str) -> None:
    """Prints a line. On a terminal it first wipes the percentage that
    `_progress` may have left on the current line."""
    if sys.stdout.isatty():
        sys.stdout.write("\r        \r")
    print(text, flush=True)


def _progress(source: Source) -> Callable[[int], None]:
    """Percentages for one download: updated in place on a terminal, a line
    every quarter when the output goes to a file or another program."""
    live, shown = sys.stdout.isatty(), [-1]

    def show(done: int) -> None:
        percent = done * 100 // source.bytes
        step = percent if live else percent // 25 * 25
        if step == shown[0]:
            return
        shown[0] = step
        if live:
            sys.stdout.write(f"\r  {percent}%")
            sys.stdout.flush()
        elif step:
            print(f"  {step}%", flush=True)

    return show


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="helios_voice.models", description="The speech model files HELIOS uses.")
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("status", help="what is installed (the default)")
    get = commands.add_parser("download", help="fetch what is missing or damaged")
    get.add_argument("names", nargs="*", help="the sets to fetch; without names: everything HELIOS needs")
    get.add_argument("--all", action="store_true", help="also the optional sets")
    commands.add_parser("verify", help="re-read every installed file and compare it with the list")
    args = parser.parse_args(argv)

    models, root = shipped(), models_dir()
    if args.command == "download":
        known = {model_set.name: model_set for model_set in models.sets}
        unknown = [name for name in args.names if name not in known]
        if unknown:
            print(f"Unknown: {', '.join(unknown)}. The sets are: {', '.join(known)}", file=sys.stderr)
            return 2
        chosen = list(models.sets) if args.all else [known[name] for name in args.names] or [model_set for model_set in models.sets if model_set.default]
        print(f"Models folder: {root}\n")
        complete = download(chosen, root, _say, _progress)
        print("\nDone. Everything asked for is installed." if complete else "\nNot everything could be installed. Nothing unverified was put in place. Run the command again.")
        return 0 if complete else 1
    return 0 if report(models, root, deep=args.command == "verify") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # The half-finished download was deleted on the way out.
        print("\nStopped. Nothing unverified was put in place.")
        sys.exit(130)
