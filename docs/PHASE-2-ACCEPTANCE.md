# Acceptance checks before Phase 3

What has to be shown on the Windows laptop before Phase 3 begins, how each
thing is measured, and what was found. The setup that comes first is in
[LAPTOP-SETUP.md](LAPTOP-SETUP.md), sections 1 to 7.

**Status: nothing on this page has been run on the laptop.** Every result
below says "Not run". The tools named here were written and tested on the
development Mac, most of them against a simulated room, not against a real
microphone or real speakers.

## Rules

- **Only the laptop counts.** It is the machine HELIOS will live on. A
  result from the Mac is not a result here.
- **"Passed" is written only after the check ran on the laptop and met its
  mark.** Until then it says "Not run". A check that failed says "Failed"
  until it has been run again after the fix.
- **Figures are measured, with the tool named for them.** Nothing is
  estimated, rounded in HELIOS's favour or copied from the Mac.
- **Marks are fixed before the run.** The owner confirmed them on
  15 November 2026 (the table at the end). They are not changed after
  seeing the numbers.
- **No check writes to the real Home Base.** No test question, no test
  task, no import. Checks that create conversation turns run on a scratch
  copy (below), and the real database is left as it is.
- **Failures and fixes are written down** in the table at the end, with the
  commit that fixed them. A fix is the smallest change that solves the
  problem; nothing is rebuilt because of a check.
- **Phase 3 begins only when the owner says so**, whatever this page shows.

## Before the first check

| Step | Check |
|---|---|
| Finish sections 1 to 7 of the setup plan | Every check there holds |
| `npm run homebase -- backups list`, then `npm run homebase -- backups verify` | A snapshot from after the import exists (section 4 of the setup plan takes one) and every file in it is present and intact. Both commands only read |
| Stop the real core (Ctrl+C in its window, or end its task) | http://localhost:7117 no longer answers. One HELIOS at a time uses the microphone, and nothing touches the real database while the checks run |

### The scratch copy

A second Home Base in a temporary folder, with a copy of the real records,
on its own port. Spoken test questions land there, not in the real history.
In one Command Prompt window, in the repository folder:

```bat
set HOMEBASE_DATA_DIR=%TEMP%\hb-accept
set HOMEBASE_PORT=7127
set HOMEBASE_MODELS_DIR=%LOCALAPPDATA%\HomeBase\models
npm run homebase -- owner set-password
npm run homebase -- import <the export file>
```

Then set `"voice": { "enabled": true }` in `%TEMP%\hb-accept\config.json`
and start it in the same window, with its output kept in a file:

```bat
npm start > "%TEMP%\hb-accept-core.log" 2>&1
```

Open http://localhost:7127. The window stays empty; `type "%TEMP%\hb-accept-core.log"`
in another window shows what the core wrote. That file holds kinds of
events and durations, never what was said. (In PowerShell the first line
above is `$env:HOMEBASE_DATA_DIR = "$env:TEMP\hb-accept"`, and the others
likewise.) The speech models are only read from the real models folder;
nothing is written there.

Delete `%TEMP%\hb-accept` when the checks are done: it holds a copy of the
real records.

### Where the figures come from

| Tool | What it gives | Where it puts it |
|---|---|---|
| `uv run python -m helios_voice.bench --out FILE --ollama http://127.0.0.1:11434 --context 8192 4096` | Each speech model alone, and the local model at both context sizes: speed, cold start, memory, share on the GPU | `docs/benchmarks/<date>-windows-laptop.json` |
| `uv run python -m helios_voice.check devices`, `speaker`, `mic`, `read`, `echo`, each with `--out FILE` | The real microphone and speakers: loudness, words right, how late and how loud HELIOS's own voice returns, how long a stop takes | `docs/benchmarks/<date>-windows-laptop-audio.json` |
| The core's own log, one line per spoken exchange: `Spoken turn: transcript after … ms, first text after … ms, first sound after … ms.` | Time from the release of the talk button to the transcript, to the model's first sentence, and to that sentence being handed to the speakers | `%TEMP%\hb-accept-core.log`. The same three figures are in `GET /api/voice/status`, under `last.sinceListeningEnded` |
| `uv run python -m helios_voice.check turns --log "%TEMP%\hb-accept-core.log" --speaker-delay MS --out FILE` | Of the last ten spoken exchanges in that log: the middle value, the 90th percentile and the slowest, with the speakers' own delay added | The same audio results file |

The commands run from `apps\voice`. The `check` commands that open the
microphone or make sound wait for Enter first. Their results files hold
numbers only: no words and no device names. Loudness is in dB below full
scale (0 is the loudest possible; a quiet room is around -60). The 90th
percentile of ten runs is the ninth when they are put in order.

## The checks

In the owner's order of priority. A "mark" has to be met for the check to
pass. A "target" is preferred and is not a requirement: its check records
what was found and what was done instead.

### A. The local model

| # | Do | Measure | Mark |
|---|---|---|---|
| A1 | `ollama --version`, `ollama list` | Version, and that `qwen3.5:4b` is there | Version 0.19 or newer |
| A2 | The benchmark command above | At 8,192 and at 4,096 tokens: tokens per second, cold start, loaded size, how much of it is on the GPU and how much in ordinary memory | Target, not a requirement: at 8,192 tokens the whole model is on the GPU. If it is not, the result says so and names the fallback used (4,096 tokens, or part of the model in ordinary memory) with its figures |
| A3 | On the scratch copy, typed: "What is due this week?", then "Add a task to call the dentist next Friday", then "Which model answered?" | Whether each answer is right against the real tasks; the model named under each answer | The first is right and comes from the local model. The second asks for a yes and has the right date. The third names the local model. Any tool error is copied here word for word |
| A4 | While A3 answers: Task Manager, or `nvidia-smi --query-gpu=memory.used,memory.total --format=csv` | Peak GPU memory | None: recorded, for the 3D screen later |

### B. Microphone and speakers

| # | Do | Measure | Mark |
|---|---|---|---|
| B1 | `check devices` | Which devices exist, which are the defaults, the interface (MME, WASAPI, …) and its expected delays | The laptop microphone and the TV are listed and are the ones in use |
| B2 | `check speaker` | The owner's answer to "Did you hear it clearly?" | Yes |
| B3 | `check mic`, speaking from the usual seat | Loudest moment, loud parts, quiet parts, seconds of speech found | Not silent, not clipped, speech found |

### C. Push-to-talk

On the scratch copy's screen.

| # | Do | Measure | Mark |
|---|---|---|---|
| C1 | Hold the button, ask "What is due this week?", release | The states shown, the words shown, the spoken answer | Listening, transcribing, thinking, speaking, in that order. The words are what was said. The answer is right and is heard |
| C2 | The same with the space bar | The same | The same |
| C3 | Stop the core, start it again, open the screen | The exchange from C1 | It is still there |
| C4 | Ten spoken questions in a row | Error states, restarts of the worker (`restarts` in the voice status), questions left unanswered | Mark: no application failure in the ten. No error state, no restart, every question answered |
| C5 | Last of all, with the scratch copy stopped and the real core started again (port 7117): look, ask nothing | The screen and the voice status | The "Hold to talk" button is there and the worker is running. No question is asked: the real database gets no test turn |

### D. Stopping speech

| # | Do | Measure | Mark |
|---|---|---|---|
| D1 | `check echo --stop-after 1.5`, three times | Time from the stop until the room is quiet, heard by the microphone; time until playing hands back control | Mark: the sound has stopped within 300 ms, each time |
| D2 | On screen, press Stop while HELIOS speaks | Whether it falls silent, and the state afterwards | Silent at once, state idle |
| D3 | On screen, press talk while HELIOS speaks | Whether it stops and listens | It stops, and what is said next becomes the new request |

Known before the run: the worker stops handing sound to the speakers within
50 ms, but sound it already handed over is played out, because playing is
ended with the sound library's `stop()`, which waits for it. If D1 fails,
ending an interrupted sentence with `abort()` instead (in `play`,
`apps/voice/helios_voice/audio.py`) is the first thing to try.

### E. Recognition from two metres

Ten fixed sentences, 94 words, read aloud by the owner. The same sentences
gave 5 words wrong on the Mac with synthetic speech and no room; 4 of
those were numbers written as digits, which this count treats as wrong.

| # | Do | Measure | Mark |
|---|---|---|---|
| E1 | `check read --label "at the laptop, quiet"` | Words wrong of 94; speech and room loudness | None: the best this microphone can do |
| E2 | `check read --label "two metres, quiet"` | The same | Mark: at most 10 of the 94 words wrong |
| E3 | `check read --label "two metres, TV on"`, with the TV at its usual volume | The same | None: recorded. It decides whether the built-in microphone is enough or an external one is needed |

The owner's decision between the non-streaming and the streaming
recogniser (PROJECT_STATE, section 11) is made with these figures.

### F. Not answering itself

| # | Do | Measure | Mark |
|---|---|---|---|
| F1 | `check echo`, three times, TV at its usual volume, nobody speaking | How loud HELIOS is at the microphone, against the room and against the owner's voice in E2; how long after speaking the room is quiet again | Mark: quiet again within the guard time, 500 ms |
| F2 | From the same runs | How many of its own 19 words the recogniser makes out; the wake model's highest score on its own voice | Mark: the wake score stays below the wake threshold, 0.5. The word count is recorded: it says whether HELIOS could understand itself if the guard failed |
| F3 | In C4, afterwards | Turns in the conversation that nobody spoke | None |
| F4 | Only if the wake set is installed: wake mode on (stock "hey jarvis" model), ten spoken answers | Times HELIOS woke on its own voice | None. "Hey Helios" itself is not trained and is not checked here |

Whether echo cancellation is needed is decided from F1 and F2, and written
in the results.

### G. End of speech to first sound

| # | Do | Measure | Mark |
|---|---|---|---|
| G1 | Ten spoken questions answered by the local model, "What is due this week?" each time, after one that is not counted (the first loads every model). Then `check turns`, with the "first heard after" figure from F1 as `--speaker-delay` | To the first sound heard: the middle value, the 90th percentile and the slowest of the ten | Mark: the middle value is under 3 seconds. The 90th percentile, the slowest and the uncounted first are recorded with it |
| G2 | The same question three times, asked of Claude ("Ask Claude ..."), once an API key exists and Claude is switched on | The same, for a cloud answer | None: recorded |

"End of speech" is the release of the talk button: HELIOS cannot begin
before it. Time the owner lets pass between the last word and the release
is not in the figure.

### H. Still outstanding, not voice

| # | What | State |
|---|---|---|
| H1 | **One real call to Claude.** Needs an API key in `.env`. One request that routes to Sonnet and one to Haiku: streaming works, the stored usage and cost match the reservation, the fallback option is accepted. How: section 10 of the setup plan and the checks C1 to C12 in [CLAUDE-API.md](CLAUDE-API.md). Since 20 November 2026 Claude answers only a message that asks for it, so Sonnet is reached with "Ask Claude ..." and Haiku with `cloud check` | Outstanding: no key exists. Never run anywhere |
| H2 | `npm test` and `uv run pytest` pass on Windows; the speech models download and verify; the pytest run afterwards skips nothing | Not run (setup plan, sections 1 and 7) |
| H3 | Ending Ollama, then the voice worker, in Task Manager while HELIOS is in use | Not run. Expected: another model answers; the worker is started again after 1 second |
| H4 | Closing the browser does not stop HELIOS (setup plan, section 5) | Not run |
| H5 | Load with everything running and nobody using it | Not run |

Open in the roadmap's Phase 2 list and not settled by any check here:
protected storage for the API key, the backup that leaves the machine, and
the trained wake phrase. Each waits on a decision of the owner
(PROJECT_STATE, section 11).

## Results

One line per check, filled in on the laptop. Raw files go in
`docs/benchmarks/`.

| # | Result | Date | Figures | Notes |
|---|---|---|---|---|
| A1 | Not run | | | |
| A2 | Not run | | | |
| A3 | Not run | | | |
| A4 | Not run | | | |
| B1 | Not run | | | |
| B2 | Not run | | | |
| B3 | Not run | | | |
| C1 | Not run | | | |
| C2 | Not run | | | |
| C3 | Not run | | | |
| C4 | Not run | | | |
| C5 | Not run | | | |
| D1 | Not run | | | |
| D2 | Not run | | | |
| D3 | Not run | | | |
| E1 | Not run | | | |
| E2 | Not run | | | |
| E3 | Not run | | | |
| F1 | Not run | | | |
| F2 | Not run | | | |
| F3 | Not run | | | |
| F4 | Not run | | | |
| G1 | Not run | | | |
| G2 | Not run | | | |
| H1 | Outstanding | | | Needs an API key |
| H2 | Not run | | | |
| H3 | Not run | | | |
| H4 | Not run | | | |
| H5 | Not run | | | |

## Failures and fixes

| Date | Check | What happened | Cause | Fix, with its commit | Result when run again |
|---|---|---|---|---|---|
| 16 November 2026 | Setup, before any check: `npm test` (setup plan, section 1) | The core tests failed on the laptop, every time, in `apps/core/test/http.test.ts`. Reported by the owner; the Windows output was not seen on the Mac | A fault in the tests, not in the app. The HTTP tests share one database for the whole file, but took its folder from a helper that removes folders after every single test. The folder was deleted after the first test with the database still open in it. Windows refuses that; a Mac allows it, so the tests passed there | The commit "Keep the HTTP tests' shared folder until its server and database are closed". A shared folder now goes last of all, after its server and its database are closed. Changes in `apps/core/test` only | **Not run again on the laptop.** On the Mac: 108 of 108, also with Windows' rule imitated (a folder with an open file cannot be deleted). That is not a Windows result |

## The marks, as the owner confirmed them

Confirmed on 15 November 2026, before any run. The first two were changed
by the owner from what was proposed; the others were kept.

| Check | Mark | Requirement or target |
|---|---|---|
| A2 | The whole local model on the GPU at 8,192 tokens. Both 8,192 and 4,096 tokens are benchmarked, the memory on the GPU and in ordinary memory is recorded, and any fallback is reported | Preferred target, not a requirement |
| G1 | Time from the end of speech to the first sound: the middle value of ten runs under 3 seconds. The 90th percentile and the slowest of the ten are measured and recorded too | Requirement, on the middle value |
| C4 | No application failure in ten spoken questions | Requirement |
| D1 | The sound itself has stopped within 300 ms of being told to stop | Requirement |
| E2 | At most 10 of 94 words wrong at about two metres | Requirement |
| F1 | The room is quiet again within the guard time after HELIOS speaks, 500 ms | Requirement, from the design |
| F2 | The wake model's score on HELIOS's own voice stays below the wake threshold, 0.5 | Requirement, from the design |

No hardware check is marked "Passed" until it has run on the laptop.
