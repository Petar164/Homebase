# Home Base

A personal operating system with an AI assistant, **HELIOS**, at its centre:
a second brain that remembers, plans and, within strict limits, acts. It
runs on one always-on machine, shows itself on a TV, and is driven by voice.

Home Base is the whole system. HELIOS is the assistant inside it.

> **Status: phase 2 of 6.** The foundation works (safe storage, backups,
> login, the first screen). HELIOS answers typed and push-to-talk requests
> through tools, with approvals, using a local model, with cloud models
> behind a budget and an approval gate. It can search the web and read
> pages when that is switched on. Speech runs on the development machine.
> What has and has not been run on the target Windows machine is in the
> [roadmap](docs/ROADMAP.md); see also the
> [AI and voice stack](docs/AI-VOICE-STACK.md) and [web access](docs/WEB-ACCESS.md).

## What works today

- **Data that survives updates.** Data lives in its own folder outside the
  app. Schema changes are numbered migrations that take a snapshot first and
  either complete or leave everything as it was.
- **Backups you can trust.** Content-addressed snapshots, mirrored to a
  second drive, verifiable, restorable onto a new machine.
- **Login done properly.** One owner account created on the machine itself,
  scrypt password hashes, hashed session tokens, lockout, and a second
  password check before sensitive actions.
- **An audit log that cannot be quietly edited.** Append-only and
  hash-chained.
- **The first screen.** Time, today's focus, tasks, the week and system
  health around a slowly turning neural brain.
- **Import** of the earlier Home Base (a Claude artifact).
- **HELIOS, first version.** A conversation on the screen. The model can
  only ask for tools; the core checks every request. Reads run, changes
  wait for a yes, and sensitive data reaches a cloud model only after
  approval. Until a model is connected, a rule-based stand-in answers.
- **Memory search.** Full-text search over past conversations, on this
  machine.
- **Web access, off until switched on.** HELIOS searches the web through a
  search service and reads public pages itself, answers with numbered
  sources that are links on screen, and says so when the web fails. What a
  request may carry out of the machine is decided by fixed rules, and
  anything that could be private waits for a yes. It needs a search key.
- **Local first, with Claude on request.** The model on this machine
  answers. Claude, through Anthropic's API, answers only a message that
  begins by asking for it ("Ask Claude ..."), and only once you have
  switched it on. HELIOS never chooses it by itself. It works inside a monthly
  limit in euros, and never with sensitive records unless you said yes to
  that conversation. It needs its own API key; a Claude subscription does
  not include API use. Not yet run against the real API.

## How it is built

```
apps/core        the always-on core: API, data, backups, security (TypeScript on Node)
apps/web         the screen: React, built to static files the core serves
apps/voice       the voice worker: microphone, speech to text, speech (Python)
packages/shared  types, validation and domain logic used by both
docs/            the design
```

One process owns all data. The screen is only a view of it, so closing the
browser stops nothing. Models will propose actions; code checks and applies
them.

| Document | What it covers |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Components, boundaries, why this shape |
| [Persistence](docs/PERSISTENCE.md) | How nothing gets lost: migrations, snapshots, restore |
| [Security](docs/SECURITY.md) | Login, risk tiers, cloud approval, hostile content |
| [Data model](docs/DATA-MODEL.md) | Every table, by phase |
| [Roadmap](docs/ROADMAP.md) | Phases, acceptance criteria, risks, current state |
| [AI and voice stack](docs/AI-VOICE-STACK.md) | The models, routing, budget, measurements, and what is unverified |
| [Web access](docs/WEB-ACCESS.md) | Searching and reading the web: the flow, the search service, what leaves the machine, setup |
| [Claude as a cloud model](docs/CLAUDE-API.md) | The optional cloud model: setup, the switch, what is sent, what it costs, failures |
| [Laptop setup](docs/LAPTOP-SETUP.md) | The plan for the first session on the Windows machine |

## Run it

Needs Node 24 or newer. Nothing else: the database is SQLite, which ships
with Node.

```bash
npm install
npm run build
npm run homebase -- owner set-password
npm start
```

Then open http://localhost:7117.

The data folder is created on first start, outside this repository
(`%LOCALAPPDATA%\HomeBase` on Windows, `~/Library/Application Support/HomeBase`
on macOS). `npm run homebase -- status` shows where it is and how healthy
it is.

## The `homebase` command

```bash
npm run homebase -- status
npm run homebase -- backups list
npm run homebase -- backups create "before trying something"
npm run homebase -- backups add-mirror E:\HomeBaseBackups
npm run homebase -- backups verify
npm run homebase -- restore <snapshot>
npm run homebase -- audit verify
npm run homebase -- import <export.json>
npm run homebase -- web status
npm run homebase -- web check <words to search for>
npm run homebase -- web read <https address>
npm run homebase -- cloud status
npm run homebase -- cloud check
```

Stop the core before `restore`, `import` and `owner set-password`.

## Develop

```bash
npm test          # the no-data-loss and permission guarantees are among them
npm run typecheck
npm run dev       # the core, restarting on change
npm run dev:web   # the screen with hot reload, on port 5173
```

For `dev:web`, start the core with `HOMEBASE_DEV_HOSTS=localhost:5173` so it
accepts requests from the development address.

## Rules of this repository

It is public. That is safe because of three rules:

1. **No data here.** Real data lives in the data folder, never in this
   repository. Tests and examples use invented data only.
2. **No secrets here.** No keys, tokens or passwords in code, config or
   history.
3. **Never trust input.** Everything that arrives from a browser, a file or
   a model is checked on the server before it is used.
