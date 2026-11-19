# Project state

This file is the handoff between work sessions. It holds everything a new
session needs to continue without the earlier conversation. Rewrite it at the
end of every session. `docs/ROADMAP.md` holds the plan; this file holds where
the work actually is.

**Last updated:** 19 November 2026

## 1. Snapshot

| | |
|---|---|
| Current work | Web access (Phase 2.5): HELIOS searches the web and reads pages. Built and tested on the Mac on 18 and 19 November 2026, and committed on its own branch as a local checkpoint. It waits for the owner's word to push, for a search key, and for a run on the laptop |
| State | The AI and voice stack, the preparation for the acceptance checks and the fix for the Windows test failure are on `main` and pushed. The laptop added one commit on 17 November (`a3e834a`, "Integrate GPT-OSS 20B and improve voice diagnostics"). Web access is built on top of that, on the Mac. It is one commit on its own branch, **not pushed and not on `main`**: on 19 November the owner approved it as a local checkpoint and said not to push, merge or deploy yet. What the laptop has run is known on the Mac only from what the owner said (below) |
| Branch | `feature/web-access`, made from `main` at `a3e834a` and one commit ahead of it, on the Mac only. Nothing is uncommitted. `main` is the same as `origin/main`. Three older branches exist on the Mac only and hold nothing more: `feature/ai-voice-stack`, `laptop-acceptance`, `fix/http-test-cleanup` |
| Tests | 188 of 188 in the core (108 before, 80 for web access), 75 of 75 in the voice worker, type check clean, the screen builds, all on the Mac |
| Next phase | Phase 3 (memory and second brain). **Do not start it until the owner explicitly authorises it** |

Not verified anywhere: a real microphone and speakers (as far as the Mac
knows), a real Claude call, a web search with a real key, and the laptop's
model using the web tools.

A session on the laptop starts with `docs/LAPTOP-SETUP.md`. Its section 9
and `docs/WEB-ACCESS.md` are the part for web access. This file was written
on the Mac: every result in it is a Mac result.

### The owner's instruction for web access (18 November 2026)

- Build live web search and page retrieval into HELIOS's existing
  assistant: an implementation, with tests and a report. The feature is
  done when HELIOS can take a question that needs current public
  information, run an approved live search, open pages safely, answer with
  working source links, report failures honestly, do the same by voice,
  and pass the automated security and regression tests.
- The laptop's only local model is `gpt-oss:20b` through Ollama, with
  medium reasoning and a test context of 4,096 tokens. Keep it as the
  reasoning engine. Do not add another local model, and do not use a cloud
  model to do the searching.
- The Windows test environment uses its own data folder on port 7127. Do
  not assume the model is installed on the Mac.
- Do not build Claude API integration or Phase 3 memory now. Do not change
  the voice engine or unrelated parts of the screen. Do not modify the
  Official Style Guide PDF (no such file is in this repository).
- Treat everything from the web as untrusted data. No private record,
  conversation, account detail or file goes to a search service on its
  own; private or sensitive query content needs the owner's yes first.
- Never commit secrets or real personal data.
- **Do not push automatically.** Leave the changes ready for review and
  commit.

On 19 November 2026 the owner approved the work as a local development
checkpoint: one commit on `feature/web-access`, with the message "feat:
implement HELIOS live web intelligence". **No push, no merge into `main`
and no deploy yet.** The advisory for `@fastify/static` (section 9, point
23) is to be left as it is, for a step of its own.

What the owner said about the laptop in that message, not seen from the
Mac: the model above is in use there, and the latest commit both machines
share is `a3e834a`. Nothing was said about the results of the acceptance
checks in `docs/PHASE-2-ACCEPTANCE.md`.

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
| AI and voice stack | Done on the Mac, merged and pushed. What is still open is in sections 9 and 11 |
| 2.5 Web access | Built and tested on the Mac, committed on its own branch, not pushed. Not run with a real search key, with the laptop's model, or on Windows |
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
  folder. Keys are environment variables too, read from a `.env` file that
  git ignores: `ANTHROPIC_API_KEY`, and for web search
  `BRAVE_SEARCH_API_KEY` or `TAVILY_API_KEY`.
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
| Local model | `qwen3.5:4b`, 8K context (the default in the code) | Ollama 0.19 or newer | Ran through the whole HELIOS loop with tools. **Not installed right now**, see section 9 |
| Local model on the laptop | `gpt-oss:20b`, medium reasoning, 4,096 tokens of context (set in that machine's `config.json`; `think` may now be `low`, `medium` or `high`) | Ollama on the laptop | Never run on the Mac. Stated by the owner on 18 November 2026 |
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

### Web access

Full description: `docs/WEB-ACCESS.md`. Code: `apps/core/src/web`,
`apps/core/src/ai/webTools.ts`, and the turn loop in
`apps/core/src/ai/helios.ts`.

- Two tools for the model: `search_web` (a query, and optionally how
  recent) and `read_webpage` (the number of a search result, or an address
  the owner gave, and a question). The same model that answers everything
  else uses them.
- Search goes through a search service's API: Brave Search when
  `BRAVE_SEARCH_API_KEY` is set, otherwise Tavily with `TAVILY_API_KEY`.
  Pages are fetched by the core itself.
- Off until the owner switches it on (main screen, top right, with the
  password; or `web.enabled` in `config.json`). `web.confirmEvery` makes
  every request wait for a yes.
- Only public `https` websites are contacted. The check is made again at
  the moment of connecting and on every redirect.
- What a request may carry is decided by fixed rules
  (`apps/core/src/web/policy.ts`). Anything that could be private waits for
  the owner's yes, as an approval of kind `tool` and tier 2, and the turn
  continues from what came back once the yes is given. A key-like value is
  refused.
- Once text from the web was read in a turn, every action of tier 1 or
  higher waits for a yes for the rest of that turn, also with
  `ai.autoApproveTier1` on.
- The model sees numbered results and site names, never addresses. A page
  keeps its number for the whole conversation. The answer's sources are
  built by the core from the tool results and stored with the answer
  (`messages.content`, field `web`); a citation that matches no source is
  removed.
- Web results are sized to the model's context from the token counts the
  model reports, and are shown in short form in later turns.
- Tools may now be asynchronous and may look at one request before it runs
  (`check` in `apps/core/src/ai/tools.ts`). The seven older tools are
  unchanged.
- A new state, `browsing` ("Searching the web"), and a new event,
  `activity`, for the line of feedback while a request runs.
- The voice says an answer without source numbers and addresses
  (`apps/core/src/voice/speakable.ts`). The voice worker is unchanged.
- No migration: web requests use the existing `approvals` and `egress_log`
  tables.
- One new package: `parse5`, to read HTML.

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

`main` is pushed: `origin/main` is the same commit, `a3e834a`. The history
is one line, without merge commits. Every push from the Mac was a normal
one, made after the audit in section 13 and on the owner's yes.

**Web access is one commit that is not on `main` and not pushed.** It is
on the branch `feature/web-access` (made from `a3e834a`), on the Mac only,
made on 19 November 2026 with the message "feat: implement HELIOS live web
intelligence". This file is part of that commit, so its number is not
written here; `git log -1 feature/web-access` shows it. It holds 42 files:
the new folder `apps/core/src/web`, three other new source files, two new
test files, one new document, and changes to existing files of the core,
the screen, the shared types and the documents. `package.json` of the core
and `package-lock.json` changed for one new package, `parse5`. Nothing
under `.claude`, `private`, `home-base` or `repos` is part of it, and no
`.env` file exists. With the owner's yes it reaches the laptop the usual
way: the audit, `main` moved forward to it, a normal push.

The two newest commits on `main`:

| Commit | What |
|---|---|
| `359f898` | Keep the HTTP tests' shared folder until its server and database are closed. Made on the Mac, pushed on 16 November 2026 on the owner's yes |
| `a3e834a` | Integrate GPT-OSS 20B and improve voice diagnostics. Made on the laptop on 17 November 2026: `think` in the local model's settings may be `low`, `medium` or `high`; the voice worker names the kind of a text-encoding error. Its git name differs from the one on the Mac's commits; whether that is meant is the owner's to say |

The preparation for the acceptance checks is the three commits before
those. It was made on the branch `laptop-acceptance` and came into `main`
on 15 November 2026 by moving `main` forward to it.

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

Run on 19 November 2026 on the Mac, on what the web access commit holds:

| Command | Result |
|---|---|
| `npm test` | 188 passed, 0 failed (10 files) |
| `npm run typecheck` | clean |
| `npm run build` | the screen builds |
| `cd apps/voice && uv run pytest` | 75 passed, 0 failed |

### Web access: what was tested

80 new tests in the core, in `apps/core/test/web.test.ts` (41: each part
on its own) and `apps/core/test/helios-web.test.ts` (39: inside a
conversation). The 108 earlier tests are unchanged and pass. In all of
them the internet is played by the tests: a search service and a few
websites that exist only in memory. No test contacts a real service, and
no test needs a key.

| What | Where it is tested |
|---|---|
| A search that works; a page that is read | "answering from the live web"; "searching the web"; "reading a page" |
| No results; no search service set up; web access off | "when the web does not work" |
| A service that times out or answers with something unreadable | "reports each kind of failure as what it is"; "reports a search that failed" |
| Local and private addresses are not contacted | "which addresses HELIOS may contact"; "where a name really leads" |
| Redirects and address checks | "follows redirects by hand and checks every address on the way" |
| A hostile page | "text from the web is information, never an instruction" (five tests: the page as data, no change without a yes, no details sent away, key-like values refused, searches after records wait for a yes) |
| The owner's yes and what may be sent out | "the owner's yes for what leaves this machine"; "what may be sent out"; "the switch for web access" |
| Sources are the real ones | "takes its sources from what the tools returned, never from what the model writes" |
| Through the existing turn loop | every test in `helios-web.test.ts` runs through `Helios.handleMessage` with a scripted model |
| A context of 4,096 tokens | "a small context window" |
| By voice | "by voice" |
| Nothing else broke | the 108 earlier tests |

Each protection was then switched off once, one at a time (an address rule
dropped, a redirect not checked, a limit removed, a rule about what may be
sent ignored, and so on), to see whether a test fails. Of the first 78, 73
made a test fail at once. Five did not: a circle of redirects, menus and
footers inside an article, the switch at the place where requests are
made, an empty page, and a missing search service noticed before anything
is tried. In four of them a second check caught the same thing, which is
why no test failed; the fifth was a test that was too loose. Tests were
added or tightened until every one made a test fail.

Reading the finished code once more turned up one thing no test had asked
about: while an approved web request was under way, a new message could
have been written into the same conversation. HELIOS now counts as
answering for the whole of an approved request. That is the 79th
protection, with its own test. All 79 now make a test fail when switched
off.

All 188 core tests were also run with Windows' rule imitated (a folder
cannot be deleted while a file in it is open; section 9, point 18): all
passed, and none of 245 deletions had an open file.

Also done by hand on the Mac, with the real core on a scratch data folder
(port 7127), the stand-in model, and a stand-in search service on the
machine itself that answers in Brave Search's format:

- With web access off, "Search the web for ..." was answered with "Web
  access is switched off on this machine", and the screen showed "The web
  was not reached".
- "Turn on" asked for the password, and then showed "Web access on · Brave
  Search".
- A search showed three numbered results as links. "Open source 2" fetched
  a real public page (`www.iana.org/help/example-domains`) through the
  guarded fetcher and showed its text with "1 page read".
- With `confirmEvery` on, a card "Leaves this machine" showed the query,
  the service and the reason; "Search" ran it and the answer followed.
- A search the stand-in service answered with an error was shown as "Could
  not do it: The search service had a problem of its own (status 503)".
- `web read` on the command line read real pages from four public sites,
  and refused `https://localhost/` and the cloud metadata address.

**Not done:** a search with a real key (none exists), the laptop's model
using the tools, anything on Windows, a spoken web search through a real
microphone.

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

The fix was pushed on 16 November 2026 (`359f898`), and the laptop's own
commit of 17 November sits on top of it. Whether the core tests then passed
on Windows has not been reported to the Mac. An imitation on a Mac is not a
Windows result.

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
4. **What has passed on Windows is not known on the Mac.** The core tests
   ran on the laptop on 16 November and failed in the HTTP tests (section
   7); the fix was pushed the same day. On 18 November the owner said the
   laptop runs `gpt-oss:20b` on a test instance on port 7127. No test
   result, benchmark or acceptance check from the laptop has reached this
   file or `docs/PHASE-2-ACCEPTANCE.md`.
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
19. **No web search has run against a real service.** No account and no key
    exist. The connections to Brave Search and Tavily were written from
    their documentation as read on 18 November 2026 and are tested against
    stand-ins only. The first real search is check W1 in
    `docs/WEB-ACCESS.md`. If a service refuses a request, the status code
    in HELIOS's message says which kind of refusal it was.
20. **The laptop's model has not used the web tools.** Whether
    `gpt-oss:20b` decides to search when it should, writes a usable query,
    opens a result by its number and cites it as `[1]` is not known. The
    core does not depend on it for safety, only for usefulness.
21. **4,096 tokens is very little for web search.** Ollama's own guidance
    is 32,000 or more. The core sizes what it returns from the token counts
    the model reports, and keeps a quarter of the context free. How much
    the tool descriptions and the model's reasoning really take on the
    laptop is not measured; if answers are cut off, raising
    `ai.local.contextTokens` is the first thing to try, memory permitting.
22. **The search key is an environment variable**, like the cloud key
    (point 10).
23. **`@fastify/static` has a published advisory.** `npm audit` reports it
    for the version in use (and two lesser ones in packages it pulls in).
    It was there before web access and is not caused by it. The core's own
    login check sits in front of every `/api` route and does not rely on
    that package; whether the advisory matters here has not been looked
    into, and the package has not been updated. On 19 November the owner
    set this aside for a step of its own.
24. **One layout change outside web access.** The transcript under the
    brain is now cut off at the top of its own area when it is taller than
    that area, instead of running upwards over the screen. Sources under an
    answer made that happen more often.

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
10. Web access: say when the commit on `feature/web-access` is to be
    pushed and brought into `main`. Until then the laptop cannot get it.
11. Web access: which search service, and create its key. Brave Search asks
    for a card at sign-up and says it does not share queries or train on
    them; Tavily needs no card and may use queries to improve its service.
    Both have a free monthly allowance of about 1,000 searches
    (`docs/WEB-ACCESS.md`).
12. Web access: whether every request should wait for a yes
    (`web.confirmEvery`). Off by default: only requests that could carry
    something private wait.

## 12. Exact next steps

In this order. Steps 1 to 5 and 7 need the owner in the room or a decision
of the owner.

1. **Push web access, when the owner says so.** It is one commit on
   `feature/web-access` on the Mac; `docs/WEB-ACCESS.md` explains it. With
   the owner's yes: the audit (section 13), `main` moved forward to it, a
   normal push. The owner has said not to push, merge or deploy yet.
2. **Web access on the laptop.** After the push: `git pull`, `npm install`
   (one new package), `npm run build`, `npm test`. Create a search key, put
   it in `.env`, and follow section 9 of `docs/LAPTOP-SETUP.md` and the
   checks W1 to W10 in `docs/WEB-ACCESS.md`, on the test instance on port
   7127. Write the results into that page's table.
3. **Windows laptop, acceptance checks of Phase 2**, as far as they are
   still open. Section 8 of the setup plan and
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
  The same goes for what HELIOS searches for and which pages it opens.
- **Automated tests never touch the internet.** Search services and
  websites are played by the tests. A real search or page fetch is made
  only by hand, with the owner's key, on purpose.
- **Text from the web is data.** Nothing a page says is followed, and no
  change to the web code may let a page cause an action, raise a
  permission or decide what is sent out. Each of those protections has a
  test that fails when it is switched off (section 7); keep it that way.
- **No key in the repository.** Search keys and the cloud key live in
  `.env`, which git ignores, on each machine.
- **A model changes in `models.json`, in a commit.** Never make a check pass
  by editing a hash to match a file that arrived differently.

## 14. Where things live

| What | Where |
|---|---|
| Code | this repository |
| Design documents | `docs/` |
| Speech models (about 2.3 GB) | `models` inside the data folder: `stt`, `vad`, `tts`, `wake`. What belongs there is listed in `apps/voice/helios_voice/models.json`. The `SHA256SUMS` file there is from the first download and is no longer used |
| Voice samples | `voice-audition` inside the data folder |
| Keys (cloud, web search) | `.env` next to `package.json`, ignored by git. None exists on the Mac |
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
npm run homebase -- web status                  # is web access on, and which search service
npm run homebase -- web check <words>           # one real search with the key in .env
npm run homebase -- web read <https address>    # fetch one page the way HELIOS does

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
