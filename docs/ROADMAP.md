# Roadmap

The whole design is fixed up front (see [architecture](ARCHITECTURE.md)).
It is built in phases. Every phase ends with the project working and
committed, so work can stop after any step without leaving a broken state.

## Status

| Phase | State |
|---|---|
| 1. Foundation | Built and tested on a Mac. Not yet run on the Windows laptop |
| 2. HELIOS core | In progress: text conversation, routing and budget built; the AI and voice stack is being integrated on a branch |
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

**Last updated:** 15 November 2026, early morning

**Current work: the AI and voice stack**, on the branch
`feature/ai-voice-stack` (not merged, not pushed). The brief and what is
verified so far are in [AI-VOICE-STACK.md](AI-VOICE-STACK.md). Phase 3 does
not start until this is integrated, tested and documented.

**Done on the branch**

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
- 86 automated tests pass.

**In progress / next, in order**

1. Done: `qwen3.5:4b` runs through HELIOS's Ollama connection and calls
   tools (first run in AI-VOICE-STACK.md). On the Mac this uses a current
   Ollama run separately on port 11435, because the installed one (0.18.3)
   is too old for this model. Still to do: a full conversation through the
   HELIOS loop with the real model, and dates spelled out in the tool
   descriptions (the model sent "tomorrow" as a deadline).
2. Done: the "which model answered, and what has it cost" tool, and the
   detector that labels obvious keys and passwords as secret.
3. Build the voice worker: protocol over standard input and output, mock
   audio and engines for tests, then the real ones.
4. The core's voice supervisor, routes for push-to-talk and cancel, speech
   into the conversation, answers spoken sentence by sentence.
5. Push-to-talk on the screen.
6. Wake word plumbing; document what training "Hey Helios" takes.
7. The audition tool and the benchmarks (one model per process).
8. Finish AI-VOICE-STACK.md, update ARCHITECTURE.md, final report.

**Not done / not verified**

- Nothing has run on the Windows laptop.
- No real model has answered yet: no API key exists, and the local model's
  first run is pending.
- No microphone or speaker has been used yet. Speech tests so far fed
  synthesised audio straight to the recogniser.

**Practical notes for the next session**

- Speech models are in the `models` folder of the default data folder. The
  Python environment is `apps/voice/.venv` (run things with `uv run`).
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
