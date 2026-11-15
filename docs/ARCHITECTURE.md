# Architecture

Home Base is the whole system. HELIOS is the assistant that lives inside it:
its voice, its reasoning and the way the screen behaves. This document
describes how the system is put together and why.

Related documents: [data model](DATA-MODEL.md), [persistence](PERSISTENCE.md),
[security](SECURITY.md), [roadmap](ROADMAP.md).

## The shape of the system

```
 TV (kiosk browser) ──┐
 Laptop browser     ──┤  HTTP + a live event stream, this machine only
 Phone (later)      ──┤  (private network later)
                      ▼
        ┌──────────────────────────────────────────────┐
        │  HELIOS CORE: one always-on Node process     │
        │                                              │
        │  API · sessions · permissions · audit log    │
        │  orchestrator · memory · tools · scheduler   │
        │  backups · updates                           │
        └───┬──────────────┬──────────────┬────────────┘
            │              │              │
     Voice worker     Local models    Cloud models
     (microphone,     (on the GPU)    (Claude API,
      wake word,                       behind an
      speech)                          approval gate)
            │
            ▼
      DATA FOLDER, outside the app folder
      database · knowledge vault · files · outputs · backups
```

Three rules hold everything else up:

1. **One authority.** Only the core reads and writes the data folder. The
   screen, the voice worker and the models all go through the core's API.
2. **Code and data live apart.** The app folder can be deleted, replaced or
   updated at any time. The data folder is never inside it.
3. **Models propose, code decides.** A model never writes to the database or
   runs a tool directly. It returns a structured request; the core validates
   it, checks permission, applies it and writes the audit entry.

## Why this shape

**A core process instead of a web framework server.** HELIOS must keep
listening, run scheduled jobs and finish long tasks while the screen is
closed. A request-and-response web server is the wrong host for that. So the
core is a plain long-running program, and the screen is only a view of it.
Closing the browser changes nothing.

**SQLite instead of a database server.** One user, one machine. SQLite is a
single file, which makes "back it up", "restore it" and "move it to another
machine" simple and testable. It has full-text search built in and takes a
vector extension for memory search. There is no second service to keep alive.
Node ships with SQLite, so nothing native has to be compiled on Windows.

**Hand-written, numbered migrations instead of an auto-migrating ORM.**
Auto-migration tools can decide to reset a database when the schema drifts.
Here every schema change is a reviewed SQL file that runs once, inside a
transaction, after an automatic snapshot.

**The screen is a single-page React app served by the core.** It needs no
server rendering. It needs a live event stream, a 3D canvas and to be reachable later
from a phone. One process, one port.

**The voice worker is a separate small program.** Speech recognition and
speech synthesis run best in Python on the GPU, and audio drivers crash more
often than anything else. As its own process with a narrow protocol
(audio in, text out; text in, audio out) it can be restarted or replaced
without touching the core.

## Components and their boundaries

| Layer | What it is | Owns | Never does |
|---|---|---|---|
| Frontend | `apps/web`: React, TypeScript, Tailwind. TV screen, login, Home Base screens | Layout, animation, the 3D brain | Talk to the database, hold secrets, decide permissions |
| Backend | `apps/core`: Node, TypeScript, Fastify | The API, sessions, the single write path to data | Run model output as code |
| Voice | `apps/voice` (phase 2): Python worker, supervised by the core | Wake word, speech-to-text, text-to-speech, the audio devices | Decide what to do with what it heard |
| AI orchestration | Module in the core | Choosing a model, building the prompt, the tool loop, cost limits | Call a cloud model with sensitive context without approval |
| Memory | Module in the core | Transcripts, extracted memories, the knowledge graph, retrieval | Present an interpretation as a fact |
| Persistence | Module in the core | The data folder, the database, migrations | Create a blank database over an existing one |
| Permissions and auth | Module in the core | Login, step-up authentication, risk tiers, standing grants, the audit log | Accept voice alone for a sensitive action |
| Tools and integrations | Module in the core + child processes | Files, PDFs, browser, apps, MCP servers, plugins | Run outside the scope it was granted |
| Scheduler and agents | Module in the core | Recurring jobs, long-running agent runs, their step logs, the kill switch | Start work that has no grant |
| UI visualisation | In `apps/web` | Turning HELIOS's state into what the brain and widgets do | Carry logic: it only renders state the core sends |
| Updates and backups | Module in the core + `homebase` command | Snapshots, mirrors, restore, update and rollback | Update or migrate without a snapshot first |

## How one spoken request travels

"Helios, what is due this week?"

1. The voice worker hears the wake word, records until the speaker stops and
   turns the audio into text. It sends the text to the core.
2. The core stores the message in the conversation and sets the state to
   *thinking*. The screen sees the state over the event stream and the brain
   changes.
3. The orchestrator asks memory for relevant context, and builds a prompt.
   Every piece of context carries a sensitivity label.
4. The router picks a model. Routine questions go to the local model. Hard
   ones go to the cloud model, but only if nothing in the context is labelled
   sensitive, or the owner approves that specific request.
5. The model answers with text and, if needed, tool requests. Each request is
   checked against its schema, its risk tier and the current grants. Reading
   tasks is tier 0 and runs at once.
6. The answer is stored, sent to the screen and to the voice worker, which
   speaks it. State returns to *idle*.

Every step from 3 to 5 leaves an audit entry.

## The model layer

Models sit behind one interface (`chat`, with tools and streaming), so no
part of the system depends on one vendor.

| Role | Default | Notes |
|---|---|---|
| Cloud reasoning | Claude, through the official SDK (`claude-opus-5-5`) | Billed per use, separately from any Claude subscription. Needs a monthly cap |
| Cloud bulk work (summaries, extraction) | `claude-haiku-5-5` | Far cheaper; used for background passes over transcripts |
| Local reasoning | A 7 to 8 billion parameter model through Ollama | Must fit in 8 GB of GPU memory next to speech models. Chosen by testing on the laptop |
| Local embeddings | A small embedding model through Ollama | Memory search never needs the cloud |
| Tests | A scripted fake model | The whole pipeline is testable without a key or a GPU |

Model names are configuration, not code.

## Memory in one paragraph

Raw records are kept exactly as they happened and are never rewritten:
conversation transcripts, imported Claude conversations, indexed documents.
On top of them sits a derived layer: summaries, decisions, action items, open
questions, people, projects, themes and the links between them. Derived items
are written as *proposals* with a source and a confidence, and each is marked
as a fact, a preference or an interpretation. Interpretations can be edited
or rejected, and are never stated as fact. Search combines full-text search,
vector similarity, recency and graph links, and runs locally.

## Interface

The screen is one continuous environment for a TV across a room, driven by
voice.

- **The brain** fills most of the screen: a slowly rotating neural structure,
  built from points and connections, artistic rather than anatomical. Its
  size and density come from real numbers in the database (conversations,
  memories, links), so it grows as HELIOS learns. A monthly image of it is
  saved to the archive.
- **States, not pages.** The core publishes one state at a time: idle,
  listening, thinking, searching memory, retrieving, speaking, acting,
  presenting. The brain and widgets react to it. Searching lights regions and
  pulses connections. Presenting moves the brain aside, shows the result,
  asks whether to save it, then returns.
- **Always visible:** time, date, weather, the week along the bottom, today's
  focus, deadlines, tasks, business numbers, training, system status.
- **Palette:** near-black, greys and off-white, with two restrained accents:
  a very dark purple and a pale salmon. No neon.
- **Built for ten feet away:** large type, strong contrast, margins that
  survive TV overscan, no hover-only controls, slow drift on static elements
  to protect the panel.
- **Ambient mode** after 21:00 dims the screen and slows motion.
- **Transcripts** are optional and toggled by voice.

## Repository layout

```
apps/core      the always-on core (TypeScript, runs on Node directly)
apps/web       the screen (React, built to static files the core serves)
apps/voice     the voice worker (Python, phase 2)
packages/shared  types, validation schemas and pure domain logic used by both
docs/          these documents
```

The data folder is not in this list on purpose. See
[persistence](PERSISTENCE.md).

## What is deliberately not here yet

Webcam presence, gesture control, smart-home control and the phone app are
planned for the last phase. The architecture leaves room for each (a new
worker process, a new tool, a new client of the same API) but nothing is
built for them now.
