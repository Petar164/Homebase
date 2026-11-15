# Roadmap

The whole design is fixed up front (see [architecture](ARCHITECTURE.md)).
It is built in phases. Every phase ends with the project working and
committed, so work can stop after any step without leaving a broken state.

## Status

| Phase | State |
|---|---|
| 1. Foundation | In progress |
| 2. HELIOS core | Not started |
| 3. Memory and second brain | Not started |
| 4. Neural interface | Not started |
| 5. Action and integrations | Not started |
| 6. Evolution | Not started |

The detailed step-by-step state of the current phase is at the bottom of
this file, under "Where the work stands".

## Phase 1: Foundation

Goal: a core that keeps data safe across updates, with login and the first
Home Base screen.

Done when:

- [ ] A first start creates the data folder outside the app folder. A
      restart finds the same data.
- [ ] Adding a migration and restarting takes a snapshot first, and existing
      rows are still there afterwards.
- [ ] A failing migration leaves the database unchanged.
- [ ] Code older than the database refuses to start.
- [ ] A data folder with a missing database refuses to start blank.
- [ ] Snapshot, verify and restore round-trip the database and files
      exactly, and a restore snapshots the current state first.
- [ ] Snapshots mirror to a second folder (the external drive) and can
      restore a machine that lost its data folder.
- [ ] Snapshots run on a schedule and old ones are thinned.
- [ ] Only the owner can log in; failed attempts are limited; every data
      route rejects requests without a session.
- [ ] The audit log detects an edited or removed entry.
- [ ] The existing Home Base data (tasks, calendar, training, sales, ledger,
      settings) imports from an export of the Claude artifact version.
- [ ] The TV screen shows time, date, today's focus, tasks, deadlines, the
      week and system status from real data.

## Phase 2: HELIOS core

Goal: talk to HELIOS by text and by voice, with every exchange stored.

- One model interface with three implementations: Claude, a local model, a
  scripted fake for tests.
- A router that chooses between local and cloud, with the cloud approval
  gate and a monthly cost cap.
- Conversations and messages stored; state changes streamed to the screen.
- Read-only tools over Home Base records; changes proposed by the model and
  applied by the core after validation.
- Voice worker, first version: push-to-talk, speech-to-text, spoken reply.
  Then the wake word.
- The core starts with Windows and keeps running with the screen closed.
- Off-machine encrypted backup.

Done when:

- [ ] "What is due this week?" typed or spoken gets a correct answer taken
      from the database, and the exchange is still there after a restart.
- [ ] A request whose context includes sensitive data does not reach the
      cloud until approved, and the egress log shows the decision.
- [ ] Closing the browser does not stop HELIOS answering.
- [ ] The monthly cap stops cloud calls when reached.
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

**Last updated:** 15 November 2026

**Done**

- Repository audit. Design documents written.

**In progress**

- Phase 1: restructuring the repository into `apps/core`, `apps/web` and
  `packages/shared`.

**Next**

1. Core: data folder, database, migrations, snapshots, restore, with tests.
2. Core: login, sessions, audit log, with tests.
3. Core: Home Base records, import from the artifact export.
4. Web: login and the TV screen.
