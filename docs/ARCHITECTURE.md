# Architecture

Home Base is the whole system. HELIOS is the assistant that lives inside it:
its voice, its reasoning and the way the screen behaves. This document
describes how the system is put together and why.

Related documents: [data model](DATA-MODEL.md), [persistence](PERSISTENCE.md),
[security](SECURITY.md), [web access](WEB-ACCESS.md),
[Claude as a cloud model](CLAUDE-API.md), [roadmap](ROADMAP.md).

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

The core also reaches the public web, when the owner has switched that
on: a search service through its API, and public pages that it fetches and
reads itself ([WEB-ACCESS.md](WEB-ACCESS.md)).

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
| Voice | `apps/voice`: a Python worker the core starts as a child process and restarts if it dies | The microphone and speakers, speech detection, speech to text, text to speech, the wake word | Decide what to do with what it heard, or grant any permission |
| AI orchestration | Module in the core (`src/ai`) | Choosing a model by fixed rules, the tool loop, the euro budget, the record of every cloud call | Call a cloud model with sensitive context without approval, or show secret content to any model |
| Memory | Module in the core | Transcripts, extracted memories, the knowledge graph, retrieval | Present an interpretation as a fact |
| Persistence | Module in the core | The data folder, the database, migrations | Create a blank database over an existing one |
| Permissions and auth | Module in the core | Login, step-up authentication, risk tiers, standing grants, the audit log | Accept voice alone for a sensitive action |
| Tools and integrations | Module in the core + child processes | Files, PDFs, browser, apps, MCP servers, plugins | Run outside the scope it was granted |
| Web access | Module in the core (`src/web`) | Searching through a search service's API, fetching and reading public pages, the rules for what a request may carry, the numbered sources of an answer | Contact anything that is not a public website, run anything a page contains, or send out a record of the owner's without a yes |
| Scheduler and agents | Module in the core | Recurring jobs, long-running agent runs, their step logs, the kill switch | Start work that has no grant |
| UI visualisation | In `apps/web` | Turning HELIOS's state into what the brain and widgets do | Carry logic: it only renders state the core sends |
| Updates and backups | Module in the core + `homebase` command | Snapshots, mirrors, restore, update and rollback | Update or migrate without a snapshot first |

## How one spoken request travels

"Helios, what is due this week?"

1. The voice worker records while the talk button is held (or, later, from
   the wake word until the speaker stops) and turns the audio into text. It
   sends the text to the core.
2. The core stores the message in the conversation and sets the state to
   *thinking*. The screen sees the state over the event stream and the brain
   changes.
3. The orchestrator asks memory for relevant context, and builds a prompt.
   Every piece of context carries a sensitivity label.
4. The router picks a model by fixed rules. Routine questions go to the
   local model. Hard ones go to the cloud model, but only if cloud use is on,
   the month's budget has room, and nothing in the context is labelled
   sensitive, or the owner approves that specific request.
5. The model answers with text and, if needed, tool requests. Each request is
   checked against its schema, its risk tier and the current grants. Reading
   tasks is tier 0 and runs at once.
6. The answer is stored and sent to the screen, and each finished sentence
   goes to the voice worker, which speaks it while the rest is still being
   written. State returns to *idle*.

Every step from 3 to 5 leaves an audit entry.

## The model layer

Models sit behind one interface (`chat`, with tools and streaming), so no
part of the system depends on one vendor.

| Role | Model | Notes |
|---|---|---|
| Local reasoning, the default | `qwen3.5:4b` through Ollama | Ordinary conversation and Home Base questions. Runs on the GPU |
| Cloud, hard reasoning | `claude-sonnet-5-5` through the official SDK | Long or analytical requests, or when asked. Optional: off until the owner switches cloud models on ([CLAUDE-API.md](CLAUDE-API.md)). Billed per use, separately from any Claude subscription |
| Cloud, light work | `claude-haiku-5-5` | Extraction, classification, summaries, background passes |
| Local embeddings (phase 3) | A small embedding model through Ollama | Memory search never needs the cloud |
| Stand-in | Fixed rules | Answers only while no real model is connected |
| Tests | A scripted model | The whole pipeline is testable without a key or a GPU |

Speech runs on the CPU and leaves the GPU to the language model and the
screen: Parakeet Unified for speech to text, Silero for speech detection,
Kokoro for the voice, openWakeWord for the wake phrase.

On the laptop the local model is `gpt-oss:20b` with a context of 4,096
tokens, set in that machine's `config.json` (as the owner stated on
18 November 2026; it has not been run on the development machine).

Model names, limits and prices are configuration, not code. Which model
answers, the budget, the measurements and what is still unverified are in
[AI-VOICE-STACK.md](AI-VOICE-STACK.md).

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
  listening, thinking, searching memory, searching the web, retrieving,
  speaking, acting, presenting. The brain and widgets react to it. Searching lights regions and
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
apps/voice     the voice worker (Python, run with uv)
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
