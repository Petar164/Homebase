# Project state

This file is the handoff between work sessions. It holds everything a new
session needs to continue without the earlier conversation. Rewrite it at the
end of every session. `docs/ROADMAP.md` holds the plan; this file holds where
the work actually is.

**Last updated:** 15 November 2026, late evening

## 1. Snapshot

| | |
|---|---|
| Current work | The AI and voice stack, built between Phase 2 and Phase 3 |
| State | Built, tested and documented on the Mac. Merged into `main` and pushed on 15 November 2026, with the owner's yes. **Next: the first session on the Windows laptop** |
| Branch | `main`, the same as `origin/main`. Nothing is uncommitted. The old branch `feature/ai-voice-stack` exists on the Mac only and holds nothing more |
| Tests | 98 of 98 in the core, 54 of 54 in the voice worker, type check clean, all on the Mac |
| Next phase | Phase 3 (memory and second brain). **Do not start it without the owner's word** |

Three things are not verified anywhere: a real microphone and speakers, a
real Claude call, and everything on the Windows laptop.

A session on the laptop starts with `docs/LAPTOP-SETUP.md`. This file was
written on the Mac: every result in it is a Mac result.

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
| 1. Foundation | Done on the Mac, pushed. Not yet run on Windows |
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
  written. "Stop" cuts speech within 50 ms.
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

## 6. Git state

Everything is on `main`, and `main` is pushed: `origin/main` is the same
commit. Nothing is uncommitted. The history is one line, without merge
commits.

The AI and voice stack is the last 13 commits. It was built on the branch
`feature/ai-voice-stack` and came into `main` on 15 November 2026 by moving
`main` forward to it. The push was made after the audit in section 13. The
branch still exists on the Mac only. It was never pushed and can be deleted.

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
| the newest | Pin the speech models: a list with checksums, a download command and a check before loading. This file is part of that commit, so its number is not written here; `git log -1` shows it |

Before these, `main` held 15 commits, up to `46a8d33`.

## 7. Tests

Run on 15 November 2026 on the Mac, on the code that was pushed:

| Command | Result |
|---|---|
| `npm test` | 98 passed, 0 failed (7 files) |
| `npm run typecheck` | clean |
| `cd apps/voice && uv run pytest` | 54 passed, 0 failed |

Of the 54 voice tests, 6 use the real speech models and are skipped on a
machine that does not have them, and 1 needs the optional `openwakeword`
package. Each of the ten acceptance points of the AI and voice brief has an
automated test; the table is in `docs/AI-VOICE-STACK.md`.

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
so no microphone was opened and no sound was played.

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
4. **Nothing has run on Windows.** Not the tests, not the models, not the
   benchmarks.
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

The work was pushed so that the Windows laptop can get it. The laptop is
next. Steps 2 to 5 each need the owner, and each can be done on the laptop
instead of the Mac.

1. **Windows laptop.** Clone the repository from GitHub and follow
   `docs/LAPTOP-SETUP.md` from the top (section 7 there is speech). The
   owner brings the export file over separately; it never goes through the
   repository. Run all tests, then
   `uv run python -m helios_voice.bench --out results.json --ollama http://127.0.0.1:11434`
   in `apps/voice`, and save the result under `docs/benchmarks/`. Check video
   memory with the local model loaded, the microphone at two metres with TV
   sound, and killing Ollama or the worker during use.
2. **Local model.** On the laptop this is section 6 of the setup plan. On
   the Mac it needs Ollama updated first: then `ollama pull qwen3.5:4b`,
   start the core against a scratch data folder, repeat the five-turn
   conversation.
3. **One real Claude call.** Put `ANTHROPIC_API_KEY` in `.env` (ignored by
   git). Send one request that routes to Sonnet and one to Haiku. Check
   streaming, the stored usage, the cost against the reservation, and that
   the fallback option is accepted.
4. **Audio with the owner present.** Allow microphone access, then test
   recording, push-to-talk end to end, stopping speech, and feedback from
   the speakers. Measure end of speech to first sound.
5. **Voice choice.** Apply the owner's pick through `PUT /api/voice/settings`
   or `config.json`.
6. **If streaming is chosen:** wire partial transcripts from the streaming
   export into the worker and show them on screen.
7. **Backlog:** protected storage for the API key, and a backup that leaves
   the machine. Both wait on the owner (section 11, points 8 and 9).
8. **Phase 3**, only after the owner says so.

## 13. Working rules for the next session

- **Do not merge, push or deploy without the owner's yes.** Each push needs
  its own yes.
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
- **Do not play sound through the speakers when nobody is there.**
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
```
