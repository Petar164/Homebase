# Roadmap

The whole design is fixed up front (see [architecture](ARCHITECTURE.md)).
It is built in phases. Every phase ends with the project working and
committed, so work can stop after any step without leaving a broken state.

## Status

| Phase | State |
|---|---|
| 1. Foundation | Built and tested on a Mac. Not yet run on the Windows laptop |
| 2. HELIOS core | In progress: text conversation, routing and budget built; the AI and voice stack is built and merged, tested on the Mac only |
| 2.5 Web access | Built and tested on the Mac, with the internet played by the tests. Not yet run with a real search key, with the laptop's model, or on the laptop |
| 2.6 Claude as an optional cloud model | A first version, built and tested on the Mac with stand-ins. Not yet run against the real API: no key exists |
| 3. Memory and second brain | First piece built: full-text search over conversations |
| 4. Neural interface | Not started |
| 5. Action and integrations | Not started |
| 6. Evolution | Not started |

The detailed step-by-step state of the current phase is at the bottom of
this file, under "Where the work stands".

## Phase 1: Foundation

Goal: a core that keeps data safe across updates, with login and the first
Home Base screen.

Done when (each line has an automated test unless it says otherwise):

- [x] A first start creates the data folder outside the app folder. A
      restart finds the same data.
- [x] Adding a migration and restarting takes a snapshot first, and existing
      rows are still there afterwards.
- [x] A failing migration leaves the database unchanged.
- [x] Code older than the database refuses to start.
- [x] A data folder with a missing database refuses to start blank.
- [x] Snapshot, verify and restore round-trip the database and files
      exactly, and a restore snapshots the current state first.
- [x] Snapshots mirror to a second folder (the external drive) and can
      restore a machine that lost its data folder.
- [x] Snapshots run on a schedule and old ones are thinned.
- [x] Only the owner can log in; failed attempts are limited; every data
      route rejects requests without a session.
- [x] The audit log detects an edited or removed entry.
- [x] The existing Home Base data (tasks, calendar, training, sales, ledger,
      settings) imports from an export of the Claude artifact version.
      Checked by hand against a real export as well.
- [x] The screen shows time, date, today's focus, tasks, the week and system
      status from real data. Checked by hand in a browser.
- [ ] All of the above also holds on the Windows laptop. Not run there yet.

Left over from this phase, to slot in where they are needed:

- The other Home Base screens (tasks by area, training log, sales and
  taxes, analytics). Their records are stored and imported; only the main
  screen and tasks have an API and a screen so far.
- Weather on the main screen (needs a data source; phase 4).
- An "export everything" button in the Claude artifact, so a fresh export
  can be made without help.
- Two newer artifact settings (`chargesVat`, `taxRate`) are not imported yet.

## Phase 2: HELIOS core

Goal: talk to HELIOS by text and by voice, with every exchange stored.

Built so far (each with automated tests):

- [x] One model interface with a rule-based stand-in, so everything around
      the model works before a real one is connected.
- [x] Conversations and messages stored; transcripts are never rewritten and
      survive a restart.
- [x] Tools with risk tiers. Reads run; changes wait for the owner's yes; an
      approval runs exactly the action that was approved, once.
- [x] The router: local first; a conversation holding sensitive data reaches
      a cloud model only after approval; monthly cost cap; every cloud call
      logged.
- [x] The event stream, and the conversation on the screen with approval
      requests. Checked by hand in a browser with the stand-in.
- [x] Connections to Claude and to a local model through Ollama, written to
      their documented interfaces and tested against fakes.

Not done:

- [ ] A first real call to Claude (needs an API key) and to a local model
      (needs Ollama on the laptop). Until then both connections are unproven.
- [ ] Keys in the operating system's protected storage instead of an
      environment variable.
- [ ] Voice worker: push-to-talk, speech-to-text, spoken reply, then the
      wake word.
- [ ] The core starting with Windows and running with the screen closed.
- [ ] Off-machine encrypted backup.

Done when:

- [ ] "What is due this week?" typed or spoken gets a correct answer taken
      from the database, and the exchange is still there after a restart.
      (Typed, with the stand-in: done. With a real model, and spoken: not yet.)
- [x] A request whose context includes sensitive data does not reach the
      cloud until approved, and the egress log shows the decision.
- [ ] Closing the browser does not stop HELIOS answering.
- [x] The monthly cap stops cloud calls when reached.
- [ ] Speech round trip on the laptop: under 3 seconds from end of speech to
      start of reply for a local answer.

How the open lines are checked on the laptop, with which tool and against
which mark, and what was found, is in
[PHASE-2-ACCEPTANCE.md](PHASE-2-ACCEPTANCE.md). Nothing there has been run
yet.

## Phase 2.5: Web access

Goal: HELIOS can answer questions about what is recent or unknown to it, by
searching the public web and reading pages, without anything private
leaving the machine unasked. Full description: [WEB-ACCESS.md](WEB-ACCESS.md).

Built (each with automated tests, on the Mac):

- [x] Two tools for the model, `search_web` and `read_webpage`, in the
      existing tool system. The same local model reasons; no cloud model is
      needed.
- [x] Search through a documented API: Brave Search or Tavily, behind one
      interface, chosen by which key is present.
- [x] The core fetches pages itself: `https` only, public addresses only
      (checked at the moment of connecting, and again on every redirect),
      with limits on time, size and number.
- [x] Pages turned into readable text; what a reader cannot see is left out.
- [x] Fixed rules for what a request may carry out of the machine, with the
      existing approvals for anything that could be private.
- [x] Text from the web cannot cause a change or send details away,
      whatever it says.
- [x] Web results sized to the model's context (4,096 tokens on the
      laptop), and shortened in later turns.
- [x] Answers with numbered sources that are links on screen; failures
      shown as failures; a switch with its state on the main screen.
- [x] Spoken answers without addresses and source numbers.

Not done:

- [ ] A search with a real key. No account exists yet; the two adapters are
      written from the services' documentation.
- [ ] The laptop's model using the tools. On the Mac only the stand-in and
      scripted models did.
- [ ] Anything on Windows.

Done when (the checks are W1 to W10 in WEB-ACCESS.md, all "Not run"):

- [ ] A question that needs current public information gets an answer
      grounded in what was found, with source links that work.
- [ ] A request that needs a yes waits for it, and runs as approved.
- [ ] A failure of the web is said as a failure.
- [ ] The same works when the question is spoken.

## Phase 2.6: Claude as an optional cloud model

Goal: a hard question can go to Claude through Anthropic's API when the
owner has allowed it, inside a spending limit, without anything sensitive
leaving the machine unasked. The local model stays the default. Full
description: [CLAUDE-API.md](CLAUDE-API.md).

The provider, the routing rules, the approval before sensitive content is
sent and the budget were built with the AI and voice stack. This phase
made the cloud model something the owner switches on, and made its
failures safe.

Built (each with automated tests, on the Mac, without a key):

- [x] Off until switched on: a switch on the main screen that needs the
      password to turn on, and `cloud status` on the command line. A key
      alone, or a value an earlier version left in the settings file,
      switches nothing on.
- [x] The key is HELIOS's own business: only `ANTHROPIC_API_KEY`, handed
      to the SDK with Anthropic's own address; a value of the wrong kind
      is refused; the key is in no log, message or stored record.
- [x] Failures told as what they are (a refused key, an empty account, a
      rate limit, no connection), in HELIOS's own words.
- [x] The budget counts on the safe side: the dearer cache write in the
      estimate, both attempts when Anthropic answers with another model,
      and a call that broke off after the answer began.
- [x] Tool requests from a cloud model pass the same gate. Nothing is
      changed twice because a model failed, and an approval's yes is
      written down before its action runs.
- [x] The real SDK driven against a stand-in service on the machine
      itself: the request it sends, the stream it reads, its errors.

Not done:

- [ ] Any request to the real API. `cloud check` is the first one.
- [ ] Protected storage for the key.
- [ ] Taking back words already shown or spoken when an answer breaks off.
- [ ] Background work for the light model.

Done when (the checks are C1 to C8 in CLAUDE-API.md, all "Not run"):

- [ ] With a key and the switch on, a hard question is answered by Claude,
      the words appear as they are written, and the cost is counted.
- [ ] With the switch off, nothing is sent, whatever is asked.
- [ ] Sensitive records wait for a yes.
- [ ] A wrong key is said as a wrong key, and the local model answers.

## Phase 3: Memory and second brain

Goal: HELIOS remembers, and can find what it remembers.

- Import of Claude conversation exports, safe to run twice.
- Search that combines full-text, vectors, recency and links.
- A background pass that proposes summaries, decisions, action items, open
  questions, people, projects and themes, each tied to its source.
- A place to confirm, edit and reject what HELIOS concluded.
- Indexing of chosen folders. Notes in the vault, created only after asking.

Done when:

- [ ] Importing the same export twice adds nothing the second time.
- [ ] "What did I decide about X?" returns the right conversation, locally,
      in under 2 seconds on the laptop.
- [ ] A rejected memory no longer appears in answers.
- [ ] Interpretations are shown as interpretations and are editable.

## Phase 4: Neural interface

Goal: the screen described in the architecture document.

- The 3D brain with a distinct look for each state.
- Widgets, the week strip, ambient mode after 21:00, transcript toggle.
- Output mode: show the result, ask whether to save, return.
- The brain grows from real numbers; a monthly image is archived.

Done when:

- [ ] Each state is recognisable from across the room without reading text.
- [ ] The screen holds 30 frames per second or more on the laptop while the
      local models are loaded.
- [ ] Everything on the main screen is usable with voice only.
- [ ] The monthly image is saved without anyone asking.

## Phase 5: Action and integrations

Goal: HELIOS does things, inside limits.

- The tool registry with risk tiers, step-up authentication and grants.
- Files, PDFs, browser, app control, MCP servers, plugins.
- Saved workflows and scheduled runs; a screen showing what HELIOS is doing
  and a stop button.
- Coding agents inside granted repositories, on their own branch.
- Calendar, email and payment integrations with their own keys.

Done when:

- [ ] "Research this and save it as a PDF" produces the file, shows it, and
      asks before saving.
- [ ] A tier 3 action cannot be completed by voice alone.
- [ ] A tool asked to touch a path outside its scope is refused and logged.
- [ ] A coding run ends in a branch with commits and never merges by itself.
- [ ] Hostile instructions inside a test document do not trigger any action.

## Phase 6: Evolution

Goal: the system improves itself with permission, and reaches beyond the
laptop.

- A regular self-review: weaknesses, proposed upgrades, proposed features.
- In-app updates with notification, approval, snapshot and rollback.
- Presence detection with a webcam (opt-in, with quiet hours), gestures,
  phone access over a private network, smart-home control.

## Risks and things still to verify

| # | Risk | Why it matters | How it gets settled |
|---|---|---|---|
| 1 | Nothing has run on the Windows laptop yet | All work so far is on a Mac | A setup session on the laptop at the end of phase 1 |
| 2 | 8 GB of GPU memory and 16 GB of RAM | A local model, speech recognition, speech synthesis and a 3D screen must fit together | Measure on the laptop before choosing models |
| 3 | The laptop microphone across a room, with TV sound | Wake word accuracy; HELIOS hearing itself | Test early in phase 2; push-to-talk and an external microphone are the fallbacks |
| 4 | A custom "Helios" wake word | Needs a trained model | Evaluate in phase 2; start with push-to-talk |
| 5 | Always-on Windows | Sleep, forced updates, automatic sign-in after a restart | Power settings and a start-at-sign-in task; disk encryption because of automatic sign-in |
| 6 | Cloud model cost | API use is billed separately from a Claude subscription | A hard monthly cap; local model by default |
| 7 | Protected storage for secrets on Windows | Needs a small native bridge | Validate on the laptop in phase 2 |
| 8 | The external drive | Drive letters change; drives sleep | Marker file instead of drive letter; mirror catches up later |
| 9 | The format of Claude conversation exports | It can change | Build the importer against a real export |
| 10 | Controlling the whole laptop safely | App automation is brittle and powerful | Introduce tool by tool, each with a tier and tests |
| 11 | Integrations need their own keys | The artifact version used connections that only exist inside Claude | Register an app per service in phase 5 |

## Where the work stands

This section is rewritten at the end of every work session so the next one
can start without context.

The full handoff, with the git state, test results, open issues and the
exact next steps, is in [`PROJECT_STATE.md`](../PROJECT_STATE.md). Read that
file first.

**Last updated:** 19 November 2026

**Current work: Claude as an optional cloud model (Phase 2.6).** A first
version, built and tested on the Mac on 19 November 2026 and committed on
the branch `feature/claude-api`. Not pushed and not on `main`: that waits
for the owner's word. Cloud models are off until switched on, HELIOS
handles the key itself, failures are explained, and the budget counts on
the safe side. No real request has been made: no API key exists. What it
is, what it costs and the checks for the laptop are in
[CLAUDE-API.md](CLAUDE-API.md).

**Before that: web access (Phase 2.5) and a security fix.** Both are on
`main` and were pushed on 19 November 2026. Web access still needs a
search key, a run with the laptop's model, and a run on Windows
([WEB-ACCESS.md](WEB-ACCESS.md)). The security fix closed a fault in the
login check; the laptop has it once it has pulled. The details are in
section 7 of the handoff file.

**Before that: the AI and voice stack.** It is merged into `main` and
pushed (15 November 2026). The brief and what is verified so far are in
[AI-VOICE-STACK.md](AI-VOICE-STACK.md). Next is the first session on the
Windows laptop ([LAPTOP-SETUP.md](LAPTOP-SETUP.md)), ending in the
acceptance checks of [PHASE-2-ACCEPTANCE.md](PHASE-2-ACCEPTANCE.md): the
local model, the microphone and speakers, push-to-talk, stopping speech,
recognition from two metres, HELIOS not answering itself, and the time from
the end of speech to the first sound. Phase 3 does not start until this is
integrated, tested and documented, and the owner says so.

**Done**

- Routing between the local model, Haiku and Sonnet by fixed rules, with a
  stored reason for every answer.
- Data policy: cloud switch, approval for sensitive content, secret content
  withheld from every model.
- Budget in euros with reservations, a warning at 15 and a stop at 20.
- A failing model no longer ends the turn.
- States `transcribing`, `retrieving` and `error` added.
- The Python project for the voice worker (`apps/voice`, managed with uv,
  Python 3.12), packages installed, speech models downloaded.
- First contact: Parakeet Unified, Parakeet TDT v2 and Kokoro all run on
  the Mac.
- A list of every speech model file with its address, size and SHA-256
  (`apps/voice/helios_voice/models.json`), a command that downloads and
  verifies them, and a check of each file before the worker loads it.
- The voice worker is started without the cloud key.
- For the acceptance checks: the core times every spoken exchange from the
  release of the talk button to the first sound; `helios_voice.check`
  measures a real microphone and real speakers; the benchmark measures the
  local model at more than one context size; and the checks, their marks
  (confirmed by the owner on 15 November 2026) and an empty results table
  are written down.
- Web access (Phase 2.5): two tools for the model, search through Brave
  Search or Tavily, pages fetched and read by the core, fixed rules and
  approvals for what may be sent out, sources on screen, and spoken answers
  without addresses. On `main`, pushed on 19 November 2026.
- A security fix, pushed the same day: the package that serves the
  screen's files was brought to a version with the published fixes
  (`@fastify/static` 10.1.12; `npm audit` finds nothing), and a fault in
  the login check was closed. An address spelled with a percent-code, such
  as `/%61pi/tasks`, had reached the API without a login. The laptop has
  the fix once it has pulled.
- Claude as an optional cloud model (Phase 2.6), a first version on the
  branch `feature/claude-api`, not pushed: cloud models are off until the
  owner switches them on with the password; only `ANTHROPIC_API_KEY`
  counts and it goes to Anthropic's own address only; a failure is told
  as what it is; a call that broke off is counted as spent; nothing is
  changed twice because a model failed. Two faults in the turn loop were
  found and fixed on the way (the budget warning could land between a
  tool request and its result; a turn that went on after an approval
  could start its view somewhere else).
- 230 core tests and 75 voice-worker tests pass on the Mac (`npm test`, and `uv run pytest` in `apps/voice`).
- On the Windows laptop the core tests failed in the HTTP tests: their shared
  folder was removed while its database was still open, which Windows
  refuses. The tests' cleanup was fixed on the Mac and pushed on 16 November
  2026. Whether the tests then passed on Windows has not been reported to
  the Mac.

**In progress / next, in order**

1. Done: `qwen3.5:4b` runs through HELIOS's Ollama connection and calls
   tools. On the Mac this uses a current Ollama run separately on port
   11435, because the installed one (0.18.3) is too old for this model.
   Still to do: a full conversation through the HELIOS loop with the real
   model, and dates spelled out in the tool descriptions (the model sent
   "tomorrow" as a deadline).
2. Done: the "which model answered, and what has it cost" tool, and the
   detector that labels obvious keys and passwords as secret.
3. Done: the voice worker (`apps/voice/helios_voice`): line protocol,
   push-to-talk, Silero speech detection, Parakeet, Kokoro sentence by
   sentence, stop within 50 ms (as far as the worker goes: sound already
   handed to the speakers still plays out), wake-word mode that is deaf while HELIOS
   speaks, lazy model loading, recovery from missing devices. 14 tests with
   scripted engines, 5 with the real models in memory (`uv run pytest` in
   `apps/voice`).
4. Done: the core's side (`apps/core/src/voice`): child-process transport,
   supervisor with restarts, speech into a normal conversation turn,
   answers spoken as they are written, voice routes, combined state.
   Checked across the process boundary with the real Python worker.
5. Done: push-to-talk on the screen (hold the button or the space bar),
   a stop button while HELIOS speaks, the "think hard" option for the
   stronger model, and the model and reason under each answer. Checked in
   a browser against the real worker process with scripted engines.
6. Done: the audition tool (36 files written to the `voice-audition`
   folder, nothing played), benchmarks with one model per process
   (`docs/benchmarks/`), the streaming Parakeet export checked (it works,
   not wired in), and what training "Hey Helios" takes (not done).
7. Done: AI-VOICE-STACK.md and ARCHITECTURE.md.
8. Open, needs the owner: a first run with a real microphone and real
   speakers (microphone permission on the Mac, and sound out loud),
   including the feedback test. One real call to Claude (needs a key).
9. Done: the download command for the speech models
   (`uv run python -m helios_voice.models download`), with the worker
   refusing a file that is not the recorded one. Tested against a web
   server on the Mac itself, and by one real download of every set into a
   scratch folder.
10. Open: wiring the streaming export in for words-as-you-speak, protected
    storage for the API key.
11. Done on the Mac, to be used on the laptop: the preparation for the
    acceptance checks. A timing record in the core for each spoken
    exchange; `uv run python -m helios_voice.check` for the microphone, the
    speakers, reading aloud, HELIOS's own voice in the room and the summary
    of the latency figures; `--context` for the benchmark; and
    [PHASE-2-ACCEPTANCE.md](PHASE-2-ACCEPTANCE.md), with the marks the
    owner confirmed. The `check` commands were tested in a simulated room.
    Only the listing of devices has run on real hardware.

**Not done / not verified**

- Nothing has run on the Windows laptop.
- No Claude call has been made: no API key exists. The local model works.
  The Claude code has only met stand-ins ([CLAUDE-API.md](CLAUDE-API.md)).
- No microphone or speaker has been used yet. Speech tests fed synthesised
  audio straight to the recogniser, and the new device checks ran in a
  simulated room.
- How long HELIOS takes to fall silent on real speakers when told to stop.

**Practical notes for the next session**

- Speech models are in the `models` folder of the default data folder. The
  Python environment is `apps/voice/.venv` (run things with `uv run`).
- Anything that writes model files is tried with `HOMEBASE_MODELS_DIR` set
  to a scratch folder, never on the installed models.
- Do not play audio through the speakers unattended at night; write audio
  to files, or play it very quietly.
- Microphone access on macOS needs the owner's permission in a system
  dialog. If it is not granted, mark microphone tests as pending.
- Anything in the browser is checked against a scratch data folder on port
  7127, never the default data folder or port 7117.

**After this work (unchanged)**

- Needs the owner: an Anthropic API key, a Claude data export, the session
  on the Windows laptop ([LAPTOP-SETUP.md](LAPTOP-SETUP.md)).
- Then: the 3D brain, the invoice as a PDF, taxes and analytics screens,
  the importer for Claude conversation exports.
