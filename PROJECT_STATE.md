# Project state

This file is the handoff between work sessions. It holds everything a new
session needs to continue without the earlier conversation. Rewrite it at the
end of every session. `docs/ROADMAP.md` holds the plan; this file holds where
the work actually is.

**Last updated:** 16 November 2026

## 1. Snapshot

| | |
|---|---|
| Current work | The acceptance checks between Phase 2 and Phase 3, on the Windows laptop |
| State | The AI and voice stack is built, tested and documented on the Mac. The preparation for the acceptance checks (measuring tools, the checklist with the marks the owner confirmed, an empty results table) is done on the Mac too. Both are on `main` and pushed. Setup on the laptop has begun: its first run of the core tests failed in the HTTP tests (reported by the owner on 16 November 2026). The cause was how the tests clean up, not the app. The fix is one commit on the Mac, **not pushed and not on `main` yet**, and it has not run on Windows. **No acceptance check has been reported from the laptop** |
| Branch | `fix/http-test-cleanup`, one commit ahead of `main`, on the Mac only. `main` is the same as `origin/main` (`c33330d`). Nothing is uncommitted. Two old branches exist on the Mac only and hold nothing more: `feature/ai-voice-stack` and `laptop-acceptance` |
| Tests | 108 of 108 in the core, 75 of 75 in the voice worker, type check clean, all on the Mac |
| Next phase | Phase 3 (memory and second brain). **Do not start it until the owner explicitly authorises it** |

Three things are not verified anywhere: a real microphone and speakers, a
real Claude call, and everything on the Windows laptop.

A session on the laptop starts with `docs/LAPTOP-SETUP.md` and ends with
`docs/PHASE-2-ACCEPTANCE.md`. This file was written on the Mac: every
result in it is a Mac result.

### The owner's instruction for this stage (15 November 2026)

- Finish the Phase 2-to-3 acceptance checks before Phase 3 begins. Do not
  begin Phase 3 until the owner explicitly authorises it.
- Validate on the Windows 11 laptop, following `docs/LAPTOP-SETUP.md`.
- Preserve all existing data. Make no unnecessary architectural changes.
- Priorities: actual local-model performance; the microphone and the
  speakers; push-to-talk; interrupting speech; recognition at about two
  metres; prevention of audio feedback; time from the end of speech to the
  first audio.
- Keep the real Anthropic API verification on the outstanding checklist.
- Record actual measurements, failures and fixes in the project
  documentation. Do not claim a test has passed until it has run on the
  target hardware. Do not mark any hardware acceptance test as passed
  until it has actually run on the Windows laptop.
- Do not begin Phase 3, do not deploy, and do not modify the real Home
  Base database.
- Pushes are made normally, after the audit. No force pushes. The pushes
  made so far are fine and are not to be rolled back.

The owner approved the acceptance marks the same day, with two changes:

- The local model fully on the GPU at 8,192 tokens is the preferred
  target, not an absolute requirement. Benchmark 8,192 and 4,096 tokens,
  record the memory used on the GPU and on the CPU side, and report any
  fallback.
- For the time to the first sound, measure the median, the 90th percentile
  and the slowest of ten runs. The target for the median stays under 3
  seconds.
- Kept as proposed: no application failure in ten spoken questions; the
  physical audio stops within 300 ms; no more than 10 of 94 words wrong at
  about two metres.

## 2. What this project is

**Home Base** is the whole personal operating system: tasks, calendar,
training, money, the sales side business, backups. **HELIOS** is the AI
assistant inside it. They are two names for two things. Do not rename the app
or the repository to HELIOS.

It is developed on a Mac (Apple M5 Max, 48 GB) and is meant to run
permanently on a Windows 11 laptop (Ryzen 7 7435HS, RTX 4060 Laptop with 8 GB
of video memory, 16 GB of memory) connected to a TV, with the built-in
microphone about two metres away.

## 3. Phase status

| Phase | State |
|---|---|
| 1. Foundation | Done on the Mac, pushed. Not yet verified on Windows: its tests ran there once and failed in one file (section 7) |
| 2. HELIOS core | Core done and pushed: conversation, tools with risk tiers, approvals, cloud gate, conversation search, sales with its screen. Not everything in the roadmap's Phase 2 list is finished; see `docs/ROADMAP.md` |
| AI and voice stack | Done on the Mac, merged and pushed. Not yet run on Windows. What is still open is in sections 9 and 11 |
| 3. Memory and second brain | Not started |
| 4. Neural interface (3D brain) | Not started. The screen has a 2D canvas brain as a stand-in |
| 5. Action and integrations | Not started |
| 6. Evolution | Not started |

## 4. Architecture in short

A monorepo with npm workspaces. Full description in `docs/ARCHITECTURE.md`.

| Part | What it is |
|---|---|
| `apps/core` | The server. Node 24 or newer running TypeScript directly (no build step). Fastify, zod, SQLite through `node:sqlite`, the Anthropic SDK |
| `apps/web` | The screen. Vite, React, Tailwind, built to static files that the core serves |
| `apps/voice` | The voice worker. Python 3.12 through `uv`. Started by the core as a child process; they talk in JSON lines over stdin and stdout |
| `packages/shared` | Types, zod schemas and domain logic used by core and web |

Rules that hold everywhere:

- **Code and data are separate.** Data lives outside the repo:
  `%LOCALAPPDATA%\HomeBase`, `~/Library/Application Support/HomeBase` or
  `~/.local/share/homebase`. Override with `HOMEBASE_DATA_DIR`. Other
  variables: `HOMEBASE_PORT` (default 7117), `HOMEBASE_MODELS_DIR`,
  `HOMEBASE_DEV_HOSTS`. The port can also be set in `config.json` in the data
  folder.
- **No data loss.** Numbered SQL migrations with checksums, each in a
  transaction, with a snapshot taken first. The core refuses a database newer
  than itself, an edited migration, and a blank database where there are
  traces of earlier use. One instance at a time (lock file). See
  `docs/PERSISTENCE.md`.
- **Backups.** A content-addressed store, mirrors on other drives, restore
  with a snapshot taken first, retention by day, week and month.
- **Security.** Password with scrypt, hashed session tokens in an HttpOnly
  cookie, login lockout, step-up for sensitive actions, host and origin
  checks, an append-only hash-chained audit log, soft deletes with revisions.
  See `docs/SECURITY.md`.
- **TypeScript settings:** `erasableSyntaxOnly` (no enums, no parameter
  properties), `verbatimModuleSyntax`, imports end in `.ts`.

Migrations so far: `0001_foundation`, `0002_home_base`, `0003_conversations`,
`0004_conversation_search`, `0005_routing_and_budget` (added with the AI
and voice stack).

## 5. Model and voice stack

Full detail, measurements and sources: `docs/AI-VOICE-STACK.md`.

| Part | Choice | Runtime | State on the Mac |
|---|---|---|---|
| Local model | `qwen3.5:4b`, 8K context | Ollama 0.19 or newer | Ran through the whole HELIOS loop with tools. **Not installed right now**, see section 9 |
| Hard reasoning | `claude-sonnet-5-5` | Anthropic SDK | Written, tested against a fake. Never called for real |
| Light and background | `claude-haiku-5-5` | Anthropic SDK | Same |
| Stand-in | Rule-based, no model | In the core | Works. Answers when nothing else is available |
| Speech to text | NVIDIA Parakeet Unified English 0.6B, int8 | sherpa-onnx 2.0.1, CPU | Works on recorded audio |
| Speech to text, fallback | Parakeet TDT 0.6B v2, int8 | same | Works. Loaded automatically when Unified fails |
| Speech detection | Silero VAD | same | Works |
| Text to speech | Kokoro 82M, voice `am_michael`, int8 | kokoro-onnx 0.6.1, CPU | Works, written to files. Not played through speakers |
| Wake word | openWakeWord 0.6.0 | onnxruntime, CPU | Wiring proven with the stock `hey_jarvis` model. **"Hey Helios" does not exist** |

### Routing, data policy and budget

Code: `apps/core/src/ai/policy.ts` and `apps/core/src/ai/helios.ts`.

- Routing is by fixed rules, not by a model. Ordinary requests go to the
  local model. Long or analytical requests (`routing.complexChars`, 600) or
  "think hard" go to Sonnet. Background work goes to Haiku. The owner can
  override per message.
- Every answer stores which model wrote it and why (`messages.route_reason`).
  The screen shows it, and HELIOS can say it when asked.
- Sensitive content needs the owner's approval before it goes to a cloud
  model. Nothing is escalated to the cloud when the data policy forbids it.
- Input that looks like a password or key is stored as secret and is shown
  to no model, local or cloud (`apps/core/src/ai/secrets.ts`).
- Budget in euros: warning at 15, hard stop at 20 per month. Dollars are
  counted as euros one to one, plus 21 percent. The worst-case cost is
  reserved before each cloud call (`cloud_reservations`) and replaced by the
  real cost afterwards. At the cap the local model answers and says why.
- When a model fails, the next allowed one answers within the same turn.
- The cloud switch is on by default, but a Claude provider only counts as
  available when `ANTHROPIC_API_KEY` is set in the environment.

### Voice design

Code: `apps/voice/helios_voice` and `apps/core/src/voice`.

- The worker only hears and speaks. Every decision (model, tools,
  permissions, cloud gate) takes the same path as a typed message. A voice
  and a wake word are not authentication.
- Push-to-talk is the way in: hold the button on the screen or the space bar.
- Answers are spoken sentence by sentence while they are still being
  written. On "stop" the worker stops handing sound to the speakers within
  50 ms. Sound it already handed over is still played out (section 9,
  point 15); how long that lasts on real speakers is not measured.
- Every spoken exchange is timed on the core's clock from the moment
  listening ended (the talk button released, or the end of speech after
  the wake word): to the transcript, to the model's first sentence, and to
  that sentence being handed to the speakers. The figures are in the core's
  log, one line per exchange and durations only, and in the voice status
  under `last.sinceListeningEnded`.
- No echo cancellation. The worker ignores the microphone while it speaks
  (half duplex, with a guard of 500 ms), and the core drops a wake-word
  transcript that matches what HELIOS just said.
- The core restarts a crashed worker after 1, 2, 5, 15 and 30 seconds, then
  gives up until someone restarts it.
- Opening an audio device times out after 5 seconds, so a pending microphone
  permission cannot freeze the worker.
- The worker is started without the cloud key: the core does not pass
  `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on to it
  (`workerEnv` in `apps/core/src/voice/process.ts`).
- States shown on screen: idle, listening, transcribing, thinking,
  retrieving, speaking, acting, presenting, and error.
- Voice is off by default. Set `voice.enabled` to `true` in `config.json` in
  the data folder.

### Model files

Code: `apps/voice/helios_voice/models.py` and `models.json` next to it.

- `models.json` lists every speech model file with its address, size and
  SHA-256, grouped in sets. Four sets are what HELIOS needs with default
  settings (`parakeet-unified`, `parakeet-tdt-v2`, `silero-vad`,
  `kokoro-int8`); three are optional (`kokoro-full`,
  `parakeet-unified-streaming`, `wake-word`).
- `uv run python -m helios_voice.models download` fetches what is needed
  and missing (about 1,050 MB); `download --all` everything (about
  1,850 MB); `verify` re-hashes what is installed. Nothing is moved into
  the models folder before its size and hash matched the list. Only listed
  members are taken out of an archive.
- The worker hashes a model file before loading it and refuses one that is
  not the listed file. The error names the file and the command to run.
- The list was built from three records that agreed: the files installed
  on the Mac, the checksums written down when they were first downloaded,
  and GitHub's published size (and, for four files, SHA-256) of each
  release file.
- One real download of every set was run on the Mac into a scratch folder
  (ten downloads, 1,846 MB, a little over six minutes). Every file matched
  the list and was byte for byte the installed one.
- A file the list does not know, such as a wake model trained later, is
  loaded unchecked.

### Acceptance checks and their tools

The checks, the mark for each and the results table: `docs/PHASE-2-ACCEPTANCE.md`.
Every result there says "Not run". The marks are the ones the owner
confirmed (section 1).

- `apps/voice/helios_voice/check.py`, run as
  `uv run python -m helios_voice.check <name>`: `devices`, `speaker`,
  `mic`, `read` (ten sentences read aloud, words wrong counted) and `echo`
  (HELIOS speaks while the microphone listens: how late and how loud its
  voice returns, how long until the room is quiet, and with `--stop-after`
  how long a stop takes). They use the worker's own audio class, outside
  any conversation. Each waits for Enter before it listens or makes sound.
  `--out FILE` keeps the numbers: no words, no device names.
- `check turns --log FILE` touches no device. It reads the core's log (the
  core is started with its output kept in a file) and gives the middle
  value, the 90th percentile and the slowest of the last ten spoken
  exchanges, with `--speaker-delay` added to the first sound. A test keeps
  the line it reads in step with the line the core writes.
- **What is proven about them:** the arithmetic and the order of steps,
  in a simulated room (`apps/voice/tests/test_check.py`), and with the real
  voice, speech detector and recogniser inside that simulated room. Only
  `devices` has run on real hardware (the Mac). **No other check has met a
  real microphone or speaker.** Expect first-run problems on the laptop.
- The benchmark takes `--context 8192 4096` and measures the local model
  at each size, unloading it in between. For each it says how much of the
  model is on the GPU and how much in ordinary memory.
- The scratch copy for the checks is described on the acceptance page:
  another data folder on port 7127 with the real export imported and
  `HOMEBASE_MODELS_DIR` pointing at the installed models, so spoken test
  questions stay out of the real history.

## 6. Git state

`main` is pushed: `origin/main` is the same commit, `c33330d`. Nothing is
uncommitted. The history is one line, without merge commits. Every push
was a normal one, made after the audit in section 13 and on the owner's
yes.

**One commit is not on `main` and not pushed.** It is on the branch
`fix/http-test-cleanup`, on the Mac only, made on 16 November 2026: the
fix for the test failure the laptop found (section 7). The owner asked for
it to be committed and not pushed yet. With the owner's yes it reaches the
laptop the usual way: the audit, `main` moved forward to it, a normal push.

| Commit | What |
|---|---|
| the newest, on `fix/http-test-cleanup` | Keep the HTTP tests' shared folder until its server and database are closed. This file is part of that commit, so its number is not written here; `git log -1 fix/http-test-cleanup` shows it |

The preparation for the acceptance checks is the three commits before
that, the last three on `main`. It was made on the branch
`laptop-acceptance` and came into `main` on 15 November 2026 by moving
`main` forward to it.

| Commit | What |
|---|---|
| `39d2994` | Time each spoken exchange from the release of the talk button to the first sound |
| `eb9c96c` | Add real microphone and speaker checks; benchmark the local model at several context sizes |
| `c33330d` | Add the acceptance checks before Phase 3, with the marks the owner confirmed |

The AI and voice stack is the 13 commits before those. It was built on the
branch `feature/ai-voice-stack` and came into `main` the same day, the same
way. Both of those branches still exist on the Mac only. They were never
pushed and can be deleted.

| Commit | What |
|---|---|
| `ece248c` | Route between the local model, Haiku and Sonnet by fixed rules; enforce a euro budget |
| `228f633` | Document the AI and voice stack so far; update the handoff notes |
| `169363a` | Let HELIOS say which model answered and why; keep typed secrets away from every model |
| `4a344bb` | Record the first real run of the local model |
| `336a2f2` | Add the voice worker: speech in, speech out, over a line protocol |
| `791be70` | Connect the voice worker to the core |
| `b4ff7b3` | Add push-to-talk to the screen |
| `f336ab6` | Help small models with dates: spell out the format and list the coming days |
| `824f810` | Add benchmarks, the voice audition tool and the finished AI and voice stack document |
| `7416257` | Do not let a pending microphone permission freeze the voice worker |
| `b077654` | Add PROJECT_STATE.md: the handoff for the next session |
| `97a2b3f` | Start the voice worker without the cloud key |
| `9cc1656` | Pin the speech models by checksum: a list, a download command, a check before loading |

Before these, `main` held 15 commits, up to `46a8d33`.

## 7. Tests

Run on 16 November 2026 on the Mac, on the commit with the fix
(`fix/http-test-cleanup`):

| Command | Result |
|---|---|
| `npm test` | 108 passed, 0 failed (8 files) |
| `npm run typecheck` | clean |
| `cd apps/voice && uv run pytest` | 75 passed, 0 failed |

The AI and voice stack itself (`9cc1656`) had 98 and 54; both passed on
it. The preparation for the acceptance checks added 2 in the core (the
timing of a spoken exchange) and 21 in the voice worker (19 for the device
checks and the summary of the latency figures, 2 for the benchmark). The
pushed code (`c33330d`) therefore has 100 and 75. The fix below added 8 in
the core.

### The test failure on Windows, and its fix

**What was reported.** On 16 November 2026 the owner reported that the core
tests fail on the laptop, every time, in `apps/core/test/http.test.ts`. The
Windows output itself was not seen on the Mac.

**Cause.** A fault in the tests, not in the app. The HTTP tests open one
database and one server for the whole file, in `beforeAll`. They took the
folder for it from `tempDir()`, and `tempDir()` removes its folders after
every single test. So the folder was deleted after the first test, with the
database still open in it. Windows refuses to delete an open file. A Mac
deletes it without a word and carries on with a deleted file, which is why
all 100 tests passed there; the only trace was one stray folder left in the
temporary folder by every run.

**Fix**, in the tests only (`apps/core/test/helpers.ts` and `http.test.ts`):

- `sharedAcrossTests()` is for what a group of tests shares. It has its own
  `tempDir()` and `track()`. Its cleanup is wrapped around the whole group
  (Vitest's `aroundAll`), so it is the last thing to happen in it: everything
  tracked is closed, newest first, and only then are the folders removed.
  The HTTP tests track their database and their server, so the server
  closes, then the database, then the folder goes.
- The plain `tempDir()` and `track()` are unchanged inside a test. Outside
  one, for example in `beforeAll`, they now refuse with a message that names
  `sharedAcrossTests()`. The mistake that caused this failure therefore
  fails on a Mac too.
- Nothing outside `apps/core/test` changed, apart from the documents.

**How it was checked on the Mac.** Windows' rule was imitated: a scratch
script made deleting a folder fail while a file in it was still open in the
test process (it asks `lsof`). That script is not in the repository.

| Run of all core tests | Result |
|---|---|
| Before the fix, with the rule imitated | 1 of 100 failed: the first test of the HTTP file, at the line of the helper that removes the folder. Of 157 deletions, that one had open files (the database and its two side files) |
| After the fix, ordinary run | 108 of 108 passed, and no stray folder is left |
| After the fix, with the rule imitated | 108 of 108 passed. Of 161 deletions, none had an open file |

The 8 new tests: 7 in `apps/core/test/helpers.test.ts` for the cleanup
itself (a test's own folder is closed and then removed after that test; a
shared one stays for every test of its group and goes last of all, closed
before removed; the refusals), and 1 in the HTTP file (its data folder is
still on disk after its last test; this one failed before the fix, on the
Mac). The cleanup was then broken on purpose in 18 ways, one at a time,
among them the original mistake with and without the new refusal:

- 16 made a test fail in an ordinary Mac run.
- 1 is allowed and still passes: closing the server through a function
  returned from `beforeAll` instead of `track()`.
- 1 is not seen by an ordinary Mac run: a database opened in a shared
  folder and closed nowhere. It failed only with the rule imitated, as it
  would on Windows (section 9, point 18).

**Not done:** the fix has not run on Windows. An imitation on a Mac is not
a Windows result.

Of the 75 voice tests, 7 use the real speech models and are skipped on a
machine that does not have them, and 1 needs the optional `openwakeword`
package. Each of the ten acceptance points of the AI and voice brief has an
automated test; the table is in `docs/AI-VOICE-STACK.md`.

The tests of the device checks (`apps/voice/tests/test_check.py`) run in a
simulated room. They do not open a microphone or play a sound, and they
prove nothing about a real device. Each piece of the new logic (19 in all,
across the timing, the device checks, the summary and the benchmark) was
switched off or changed once. Three changes went unnoticed at first; the
tests were tightened until every one of the 19 made a test fail.

The 34 tests of the model files (`apps/voice/tests/test_models.py`) use a
web server on the machine itself and never reach the internet. Each
protection (hash of a download, hash of an archive member, refusal of links
and of paths outside the models folder, the check before loading, and
others, 16 in all) was switched off once, one at a time; a test failed
every time.

Also done by hand: a five-turn conversation with the real local model;
push-to-talk in a browser against the real worker process with scripted
engines; the model commands on a copy of the installed models (intact, with
one byte changed, with files removed); the real core started on a scratch
data folder with a stand-in worker, which was not handed the cloud key.

And one real download, with the owner's yes: `download --all` into an
empty scratch folder, then `verify` (passed), a comparison of all 19 files
with the installed ones (identical), the 54 voice tests on the downloaded
files (all passed, none skipped), and the full-precision voice and the
streaming recogniser run by hand. The scratch folder was deleted afterwards.

And a run for the owner to look at: the real core on a scratch data folder
with invented records and voice switched on. The screen, a typed question
answered by the stand-in, and the same exchange after a restart were
checked in a browser. The real voice worker started and stayed idle, and it
listed the Mac's microphone and speakers. The talk button was not pressed,
so no microphone was opened and no sound was played. On that copy, after
the push, the Phase 2 flows were tried in the browser with the stand-in:
a request to add a task asked for approval and ran once after the yes,
memory search found the earlier conversation, and the money summary and
the sales screen matched the invented records.

And `uv run python -m helios_voice.check devices` on the Mac's real sound
system: it listed one microphone and two speakers and their expected
delays. It opens nothing and makes no sound.

## 8. Measurements

Mac M5 Max only, speech on the CPU, synthetic speech as input. Raw numbers:
`docs/benchmarks/2026-11-15-mac-m5-max.json`.

| Model | Loads in | Speed | Memory |
|---|---|---|---|
| Kokoro int8 | 0.24 s | first sentence 0.30 s warm, 16 times real time | 398 MB |
| Parakeet Unified | 0.65 s | 24 ms per second of audio | 1,889 MB |
| Parakeet Unified, streaming | 0.67 s | first words after 1.1 s | 1,678 MB |
| Parakeet TDT v2 | 0.62 s | 23 ms per second of audio | 1,882 MB |
| Silero VAD | 0.02 s | 3 ms per second of audio | 34 MB |
| openWakeWord | 1.0 s | 19 ms per second of audio | 185 MB |
| `qwen3.5:4b` | 0.5 s | 134 tokens per second | 4,228 MB, on the GPU |

Recognition: 5 of 94 words differed on clean speech (4 were numbers written
as digits). Noise and a second voice changed little.

The table was measured before model files were checked on loading. The
check, measured afterwards in fresh processes (five runs each, without and
with it): Parakeet Unified 0.66 s and 0.88 s, Kokoro int8 0.16 s and
0.20 s, Silero VAD 0.01 s either way. Hashing all installed model files
(2.4 GB) took 0.85 s. The benchmark file was not re-run.

**Never report these as Windows figures, and never invent a figure.** Time
from end of speech to first sound through real devices is not measured.
The core now records it for every spoken exchange (section 5), so the
laptop session can read it from the log; no exchange has been spoken yet.

## 9. Unresolved issues

1. **No real microphone or speaker test.** Opening the microphone hung on
   the Mac, most likely on the system permission dialog with nobody there to
   answer. Recording, playback and the feedback test are all still to do.
   On 15 November the owner was given a running copy with voice switched
   on, to try push-to-talk. No result was reported before this file was
   written.
2. **No real Claude call.** There is no API key. Streaming, usage accounting,
   cost reconciliation and the server-side fallback option are tested only
   against a fake client.
3. **The local model is not installed on the Mac right now.** The installed
   Ollama (0.18.3, checked again this session) is too old for `qwen3.5:4b`,
   which needs 0.19 or newer. The test used the current release run
   separately on another port with its own model store; both were removed
   afterwards. The owner's install was not touched.
4. **Nothing has passed on Windows.** The core tests ran on the laptop and
   failed in the HTTP tests (section 7). The fix has not run there. Nothing
   else has been reported from the laptop: not the voice tests, not the
   models, not the benchmarks.
5. **"Hey Helios" is not trained.** Wake mode is wired but has no model for
   that phrase.
6. **Words-as-you-speak is not wired in.** The streaming Parakeet export
   works in the benchmark; the worker uses the non-streaming one.
7. **The download command has run on the Mac only.** Windows is its
   first use there.
8. **The check before loading costs time on first use**, once per start of
   the worker: about 0.2 s for the recogniser on the Mac. Not measured on
   Windows. If it matters there, the choices are to hash at worker start in
   the background, or to remember verified files by size and date.
9. **The retry for a file that Windows holds briefly** (`_move` in
   `models.py`) is tested with a stand-in only. Whether a virus scanner
   causes that on the laptop is not known.
10. **The API key is an environment variable.** Protected storage is not
    built. The voice worker no longer inherits the key.
11. **Backups do not leave the machine yet.**
12. **Migration 0005 is on `main` now.** A data folder opened once by this
    code is refused by a checkout from before the merge (`46a8d33` or
    older). No real Home Base instance exists yet (point 13), so nothing
    was affected.
13. **No real Home Base instance exists yet.** The real export has not been
    imported into a live data folder.
14. **The release pages can change.** Their owners can replace a file under
    the same name. The download then fails on purpose, and the list has to
    be updated by hand after looking at the new file.
15. **A stop may not be heard as immediate.** Found by reading the sound
    library, not by measuring: `play` in `apps/voice/helios_voice/audio.py`
    leaves its `with` block when told to stop, and the library then calls
    `stop()`, which waits until the sound already handed over has played.
    Earlier documents said "speech stops within 50 ms"; that is true of the
    worker's own step only. Check D1 measures it on the laptop. If it is
    too slow, calling `abort()` on an interrupted sentence is the first
    thing to try. Not changed now, because it could not be tried on real
    speakers.
16. **The device checks have not met a real device.** Except for `devices`,
    `helios_voice.check` has only run in a simulated room. Its timing rests
    on one assumption that only real hardware can confirm: that a piece of
    microphone sound arrives when its last sample was heard.
17. **The microphone array of a laptop may cancel echo by itself.** Windows
    sound drivers often do. Check F1 could then report that the microphone
    did not hear the speakers at all. That would be a finding to write
    down, not a fault of the check.
18. **A Mac cannot see a folder deleted with a file still open in it.**
    macOS allows it; Windows refuses. The test helpers now turn the usual
    form of that mistake into a failure on every machine (section 7). One
    form stays invisible on a Mac: something opened in a shared test folder
    and never closed. Only a test run on Windows shows it, so the core
    tests have to be run on the laptop after every change to them.

## 10. Decisions already made

- Home Base is the app, HELIOS is the assistant inside it.
- One core process owns the database. The screen and the voice worker go
  through it.
- TypeScript without a build step in the core; SQLite without an ORM.
- Audio is handled by a separate Python worker, so a crash there cannot take
  the core down.
- Half duplex plus an own-voice filter, not echo cancellation.
- Push-to-talk first. A wake word never authorises anything.
- Routing by fixed rules with a stored reason, not by a model's judgement.
- A cautious budget: one dollar counts as one euro, plus 21 percent, with
  reservations before the call.
- Provisional until the owner decides: non-streaming Parakeet Unified int8,
  and Kokoro int8 with `am_michael`.
- Made by the latest session without the owner, so also provisional: the
  model files are fixed by SHA-256 in the repository, and the worker
  refuses a file that differs rather than warning about it.
- The owner approved the merge and the push of the AI and voice stack on
  15 November 2026, after seeing the app run on the Mac with invented
  records, so that the laptop can get the code.
- The owner approved the push of the preparation for the acceptance checks
  the same day, and confirmed the marks of those checks with two changes
  (section 1). The marks are fixed: they are not changed after seeing the
  laptop's numbers.

## 11. Decisions waiting on the owner

1. Create an Anthropic API key and confirm the cap of 20 euros a month. A
   Claude subscription does not include API credit.
2. Update Ollama on the Mac. Only needed for running the local model on
   the Mac again; the laptop gets its own Ollama.
3. Pick the voice. 36 samples (nine voices, four sentences each) are in the
   `voice-audition` folder inside the data folder on the Mac. Also int8 or
   the full Kokoro model.
4. Non-streaming or streaming speech recognition.
5. Train "Hey Helios" now, or stay with push-to-talk until the laptop is set
   up.
6. What the existing `HELIOS_Brain` folder in the home folder on the Mac
   is. It was not read.
7. A Claude data export, needed for Phase 3.
8. Protected storage for the API key. The Mac half (Keychain) can be built
   and tested with the owner present, because the system may ask for
   permission; the Windows half (Credential Manager) can only be proven on
   the laptop. Build the Mac half now, or both on the laptop.
9. The backup that leaves the machine. `docs/PERSISTENCE.md` fixes the
   idea (encrypted copies in a cloud folder, the key is a recovery phrase
   on paper). Still the owner's to choose: which folder, and whether the
   laptop may hold the key or only a public half that can encrypt but not
   read.

## 12. Exact next steps

In this order. Everything the laptop needs is on GitHub, except the fix
in step 1. Steps 1 and 3 to 7 need the owner in the room or a decision of
the owner.

1. **Bring the fix for the failing tests to the laptop.** It is one commit
   on `fix/http-test-cleanup` on the Mac, not pushed (section 6). With the
   owner's yes: the audit, `main` moved forward to it, a normal push. On
   the laptop: `git pull`, then `npm test`. Expect 108 of 108. Write what
   actually happened into the failures table of
   `docs/PHASE-2-ACCEPTANCE.md`; its row for this failure still says "Not
   run again on the laptop". If the laptop has changes of its own in files
   this commit touches, commit or set them aside before pulling.
2. **Windows laptop, setup.** Follow `docs/LAPTOP-SETUP.md`, sections 1 to
   7. The repository is on the laptop already, since the tests were run
   there; how far the rest of setup got is not known on the Mac. The owner
   brings the export file over separately; it never goes through the
   repository. Before the first commit there, set the git identity
   (section 13).
3. **Windows laptop, acceptance checks.** Section 8 of the setup plan and
   `docs/PHASE-2-ACCEPTANCE.md`, in that page's order (the owner's
   priorities), on the scratch copy described there. The checks with a
   microphone or speakers need the owner in the room. Write every result,
   failure and fix into that page, and save the raw files under
   `docs/benchmarks/`. A fix is the smallest change that solves the
   problem. Nothing is "Passed" before it ran there.
4. **One real Claude call** (check H1). Needs an API key in `.env`
   (ignored by git). One request that routes to Sonnet and one to Haiku:
   streaming, the stored usage, the cost against the reservation, and that
   the fallback option is accepted. It stays on the outstanding list until
   it has run.
5. **Voice choice.** Apply the owner's pick through `PUT /api/voice/settings`
   or `config.json`.
6. **If streaming is chosen:** wire partial transcripts from the streaming
   export into the worker and show them on screen.
7. **Backlog:** protected storage for the API key, and a backup that leaves
   the machine. Both wait on the owner (section 11, points 8 and 9).
8. **Phase 3**, only after the owner explicitly authorises it.

Not needed for the laptop, and not done: the `check` commands on the Mac's
own microphone and speakers (offered to the owner as a trial run, not
taken up), and the local model on the Mac (Ollama there would have to be
updated first; section 11, point 2).

## 13. Working rules for the next session

- **Do not merge, push or deploy without the owner's yes.** Each push needs
  its own yes. Push normally: never force a push, and never roll back what
  was pushed.
- **Audit before every push:** Gitleaks over the full history, plus a manual
  look at the files being pushed. Do not print anything found. Loop over
  revisions in `bash`, not `zsh`, which does not split an unquoted variable.
- **Commits carry the owner's identity only.** No co-author lines. The git
  identity is set in the repository on the Mac. A fresh clone, such as the
  one on the laptop, has none: ask the owner, and set the same name and
  address as the existing commits before the first commit.
- **New work goes on its own branch.** `main` moves only with the owner's
  yes.
- **This repo is public.** Never commit keys, real figures, customer data,
  exports, or the `home-base`, `repos` and `private` folders. Examples in
  tests and documents must be invented, not taken from the owner's life.
- **Never test against the real data folder.** Set `HOMEBASE_DATA_DIR` to a
  scratch folder and `HOMEBASE_PORT` to another port. The models folder is
  part of it: read it, but point `HOMEBASE_MODELS_DIR` at a scratch folder
  before running anything that writes model files. Setting up the laptop
  creates the real data folder there on purpose (the setup plan, section
  2); tests and experiments still go to a scratch folder.
- **Do not touch the Ollama app installed on the Mac.** On the laptop,
  installing Ollama is part of the setup plan.
- **Do not play sound through the speakers when nobody is there.** The
  `check` commands that listen or make sound are run with the owner in the
  room, never with `--yes` on one's own initiative.
- **A check is "Passed" only after it ran on the laptop and met its mark.**
  Until then it is "Not run". Mac results, tests in a simulated room and
  expectations are none of them a pass.
- **Do not modify the real Home Base database.** No check writes to it: no
  test question, no test task, no import. Acceptance checks that create
  conversation turns run on the scratch copy described on the acceptance
  page, with the real core stopped. Before they begin, confirm that an
  intact snapshot from after the import exists (`backups list`, `backups
  verify`: both only read). Delete nothing that exists.
- **No unnecessary architectural changes.** What a check turns up is fixed
  with the smallest change that solves it, and gets a line in the failures
  table with its commit.
- **In tests, close before you remove.** Windows cannot delete an open
  file, and a Mac run does not show the mistake. `tempDir()` and `track()`
  are for one test; what a whole file shares goes through
  `sharedAcrossTests()` (`apps/core/test/helpers.ts`).
- **Never log what was said or typed.** Logs hold kinds of events only.
- **A model changes in `models.json`, in a commit.** Never make a check pass
  by editing a hash to match a file that arrived differently.

## 14. Where things live

| What | Where |
|---|---|
| Code | this repository |
| Design documents | `docs/` |
| Speech models (about 2.3 GB) | `models` inside the data folder: `stt`, `vad`, `tts`, `wake`. What belongs there is listed in `apps/voice/helios_voice/models.json`. The `SHA256SUMS` file there is from the first download and is no longer used |
| Voice samples | `voice-audition` inside the data folder |
| The owner's real export | `private/artifact-export/`, ignored by git |
| The old Next.js version | `private/legacy-nextjs-2026-11-15/`, ignored by git |

## 15. Commands

```bash
npm install                      # once
npm run build                    # build the screen
npm start                        # start the core (default port 7117)
npm test                         # core tests
npm run typecheck
npm run homebase -- status       # also: owner set-password, backups, restore, audit verify, import

cd apps/voice
uv sync                          # once
uv run pytest                    # voice tests
uv run python -m helios_voice --fake      # the worker with scripted engines
uv run python -m helios_voice.audition    # write voice samples
uv run python -m helios_voice.models            # which speech models are installed
uv run python -m helios_voice.models download   # fetch the missing ones, verified
uv run python -m helios_voice.models verify     # re-hash what is installed
uv run python -m helios_voice.bench --out results.json --ollama http://127.0.0.1:11434 --context 8192 4096
uv run python -m helios_voice.check devices     # lists microphones and speakers; opens nothing
uv run python -m helios_voice.check speaker     # these four listen or make sound: owner in the room
uv run python -m helios_voice.check mic
uv run python -m helios_voice.check read --label "two metres, quiet" --out results-audio.json
uv run python -m helios_voice.check echo --out results-audio.json    # add --stop-after 1.5 to time a stop
uv run python -m helios_voice.check turns --log core.log --speaker-delay 140    # median, 90th percentile, slowest; no device
```
