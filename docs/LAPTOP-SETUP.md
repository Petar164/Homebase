# Setting up the Windows laptop

Home Base is developed on a Mac and meant to run on the fixed Windows 11
laptop that is connected to the TV. **None of this has been run on the
laptop yet.** This page is the plan for that first session, written so it
can be handed to a Claude Code session running on the laptop itself, which
can test each step as it goes.

Every step has a check. Do not go on while a check fails.

## 1. Tools

| Step | Check |
|---|---|
| Install Git and Node 24 or newer (the LTS installer from nodejs.org) | `node -v` prints 24 or higher; `git --version` works |
| Clone this repository into a folder that is **not** synced by OneDrive | The folder holds `apps`, `docs`, `packages` |
| `npm install`, then `npm run build` | Both finish without errors |
| `npm test` | All tests pass on Windows. If any fail, stop: the failures are the first thing to fix |

## 2. First start

| Step | Check |
|---|---|
| `npm run homebase -- owner set-password` | It asks for a password twice and confirms |
| `npm start` | It prints the address and the data folder (`%LOCALAPPDATA%\HomeBase`), which must be outside the repository |
| Open http://localhost:7117 in Edge or Chrome and log in | The main screen appears |
| Stop the core (Ctrl+C), start it again | The same data is there |

## 3. Bring the existing data over

Copy the export file from the Mac (`private/artifact-export/`), or make a
fresh one, onto the laptop. Keep it outside the repository.

| Step | Check |
|---|---|
| `npm run homebase -- import <file>` | It prints how many tasks, sessions and settings were imported, and `skipped: 0` |
| Open the screen | Today's focus and the week show the real tasks and timetable |

## 4. Backups on the external drive

| Step | Check |
|---|---|
| Connect the 5 TB drive. `npm run homebase -- backups add-mirror X:\HomeBaseBackups` (X being its letter) | It reports the snapshots copied |
| `npm run homebase -- status` | The mirror shows as connected with a recent snapshot |
| `npm run homebase -- backups verify` | Every file present and intact |
| Unplug the drive, take a snapshot, plug it in, `backups sync` | The snapshot taken while unplugged arrives on the drive |
| Restore drill: `set HOMEBASE_DATA_DIR=%TEMP%\hb-drill`, then `npm run homebase -- restore <snapshot> --from X:\HomeBaseBackups --yes` | A complete copy appears in the temporary folder. Delete it afterwards |

## 5. Always on

These change Windows settings, so each one is the owner's decision.

| Step | Check |
|---|---|
| Power: never sleep while plugged in; lid close does nothing | The laptop is still reachable after an hour with the lid closed |
| Turn on disk encryption (BitLocker or device encryption) | Settings shows encryption on. Do this before automatic sign-in |
| Start the core at sign-in, in the user's own session, hidden (Task Scheduler, "At log on"). Not as a Windows service: a service cannot use the microphone or the screen | After a restart and sign-in, http://localhost:7117 answers without anyone starting it |
| Open the screen on the TV in kiosk mode (Edge: `msedge --kiosk http://localhost:7117 --edge-kiosk-type=fullscreen`) | The screen fills the TV, with no browser bars |
| Close the browser | `npm run homebase -- status` from another terminal refuses with "already running": the core is still up |

## 6. Models (phase 2)

| Step | Check |
|---|---|
| Install Ollama and pull one model that fits in 8 GB of GPU memory | `ollama list` shows it |
| Put its name in `config.json` in the data folder, under `ai.local.model`, and restart | The screen's status shows the model instead of "none connected" |
| Ask "What is due this week?" | A real answer, from the real tasks. If the tool request fails, note the exact error: the Ollama connection was written without a running Ollama |
| Watch GPU memory in Task Manager while it answers | Note the peak, for choosing speech models later |

## 7. Speech (the AI and voice stack)

These steps install speech. What is then measured, and against which
marks, is in section 8.

| Step | Check |
|---|---|
| Install uv (astral.sh/uv). In `apps\voice`: `uv sync --extra wake` | It installs Python 3.12 and the speech packages without errors |
| `uv run pytest` | All tests pass. The ones that need the real models are reported as skipped |
| `uv run python -m helios_voice.models download --all` (about 1,850 MB) | Each download is followed by "installed" and the last line says everything asked for is installed. A "NOT installed" line gives the reason; nothing unverified was put in place, and the command can be run again |
| `uv run python -m helios_voice.models verify` | "Everything HELIOS needs is installed, and every installed file matches the model list." |
| `uv run pytest` again | All tests pass and none are skipped |
| In `config.json` in the data folder set `"voice": { "enabled": true }` and restart the core | A "Hold to talk" button appears on the screen |

## 8. Acceptance checks before Phase 3

[PHASE-2-ACCEPTANCE.md](PHASE-2-ACCEPTANCE.md) lists them, with the tool
and the mark for each: the local model, the microphone and speakers,
push-to-talk, stopping speech, recognition from two metres, HELIOS not
answering itself, and the time from the end of speech to the first sound.

| Step | Check |
|---|---|
| Take a snapshot of the real Home Base and stop its core, as that page says | The snapshot verifies; port 7117 no longer answers |
| Set up the scratch copy on port 7127 described there | Its screen opens and shows the imported records and a "Hold to talk" button |
| Run the checks in the order of that page. The ones with a microphone or speakers need the owner in the room | Every line of its results table says "Passed" or "Failed" with its figures, not "Not run" |
| Write each failure and its fix in that page's table | Nothing was fixed without a line there |
| Delete the scratch copy and start the real core again | http://localhost:7117 answers; `%TEMP%\hb-accept` is gone |

A check is "Passed" only when it ran on this laptop and met its mark.

## 9. Web access (Phase 2.5)

What it is and what leaves the machine: [WEB-ACCESS.md](WEB-ACCESS.md).
Use the test instance on port 7127 for the checks.

| Step | Check |
|---|---|
| `git pull`, `npm install` (one new package, `parse5`, and a newer `@fastify/static`), `npm run build`, `npm test` | All tests pass on Windows. The tests in `static.test.ts` have only run on a Mac: if one fails, write down which address it names |
| `npm audit` | Nothing is reported. Anything listed was published after 19 November 2026: write it down |
| Sign up with Brave Search or Tavily and create an API key. The costs and the differences are in the web access page | A key exists |
| Put it in `.env` next to `package.json`, as `BRAVE_SEARCH_API_KEY=...` or `TAVILY_API_KEY=...` | `git status` does not list `.env` |
| `npm run homebase -- web status` | The search service is named |
| `npm run homebase -- web check latest local AI models` | Results come back, each with an address. This uses one search of the allowance |
| `npm run homebase -- web read https://example.com/` | The page's text is printed |
| Start the core. On the main screen, top right: "Web access off · Turn on", and enter the password | "Web access on" with the service's name |
| Run the checks W1 to W10 of the web access page and fill in its table | Every line says "Passed" or "Failed", not "Not run" |

## 10. Report back

Write down what failed and what was changed, and update "Where the work
stands" in [ROADMAP.md](ROADMAP.md) and [`PROJECT_STATE.md`](../PROJECT_STATE.md).
Risks 1, 2, 3, 5 and 8 in the roadmap are settled by this session.
Phase 3 still waits for the owner's word.
