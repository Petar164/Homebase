# AI and voice stack

Which models HELIOS uses, how they are run, what they cost, and what has
actually been tested. This page keeps three things apart on purpose:
**verified on the Mac** (the development machine), **written but not yet
run**, and **pending on the Windows laptop** (the machine HELIOS will live
on). There is no Windows result on this page.

Status: built and merged into `main`. Measurements are from
15 November 2026 on an Apple M5 Max with 48 GB of memory. The raw numbers
are in [benchmarks/2026-11-15-mac-m5-max.json](benchmarks/2026-11-15-mac-m5-max.json).

## The stack

| Job | Model | Runs through | State |
|---|---|---|---|
| Everyday reasoning, Home Base questions | `qwen3.5:4b` (4.5 billion parameters, quantisation `nvfp4`, 4.0 GB on disk) | Ollama 0.40.16, on the machine | **Works on the Mac**, through the whole HELIOS loop with tools. Needs Ollama 0.19 or newer |
| Hard reasoning, planning, analysis | `claude-sonnet-5-5` | Anthropic API, SDK 1.8.0 | Written; request checked against the SDK's types and tested with a fake. **No real call yet: there is no API key** |
| Extraction, classification, summaries, background work | `claude-haiku-5-5` | same | same |
| Speech to text | NVIDIA Parakeet Unified English 0.6B, int8, non-streaming export | sherpa-onnx 2.0.1, CPU | **Works on the Mac** |
| Speech to text with words as you speak | the same model, streaming export (560 ms steps) | sherpa-onnx 2.0.1, CPU | **Works on the Mac**; not yet wired into the worker |
| Speech to text, fallback | Parakeet TDT 0.6B v2, int8 | sherpa-onnx 2.0.1, CPU | **Works on the Mac**; used automatically if the preferred model will not load |
| Speech detection | Silero VAD | sherpa-onnx 2.0.1, CPU | **Works on the Mac** |
| HELIOS's voice | Kokoro 82M, voice `am_michael`, int8 | kokoro-onnx 0.6.1 on onnxruntime 1.32.0, CPU | **Works on the Mac** |
| Wake phrase | openWakeWord 0.6.0 | onnxruntime, CPU | The wiring works with a stock model ("hey jarvis"). **"Hey Helios" is not trained and does not work** |

Every name, context size, effort level, price and limit above is a setting
in `config.json` in the data folder (sections `ai` and `voice`), not code.
Models sit behind one interface (`apps/core/src/ai/types.ts`), so another
provider is another small file.

## What was actually tested

**Automated tests: 188 in the core (80 of them for web access, see
[WEB-ACCESS.md](WEB-ACCESS.md)), 75 in the voice worker, all passing on
the Mac.**
They cover each acceptance point of the brief:

| # | Requirement | Where it is tested |
|---|---|---|
| 1 | The right model for each routing condition | `helios.test.ts`: "picks the model for each routing condition" |
| 2 | Restricted information cannot pass the cloud gate | "never escalates to the cloud when the data policy forbids it", "does not send money data to the cloud until the owner approves" |
| 3 | Usage accounting survives restarts | "keeps its count across a restart" |
| 4 | The cap blocks further cloud use | "stops cloud calls at the monthly cap", "cannot be passed by two requests at once, or by a crash" |
| 5 | A local-model failure does not damage a conversation or the core | "falls back to another model without damaging the conversation" |
| 6 | Speech reaches the conversation pipeline | `voice.test.ts`: "turns what was heard into a stored turn and speaks the answer" |
| 7 | Speech can be interrupted | `apps/voice/tests`: "speech can be stopped at once", "pressing talk interrupts helios" |
| 8 | A voice-worker failure does not stop the core | `voice.test.ts`: "is started again with growing pauses, then left off, and the core keeps answering" |
| 9 | No words, tokens or audio in logs | "logs none of the words" (core), "no words reach the log" (worker) |
| 10 | Earlier tests still pass | all of the core's tests |

Added after the brief, in `apps/voice/tests/test_models.py`: the model
files. A download that differs from the recorded file in content or size,
or that breaks off, installs nothing. An archive cannot place a file
anywhere but the listed places. A changed file is found and replaced. Every
file each engine loads is compared with the list before the speech library
sees it. These tests use a web server on the machine itself; none of them
reaches the internet. Each of these protections was also switched off once,
one at a time, to confirm that a test then fails. And in the core
(`voice.test.ts`, "starts the worker without the cloud key"): the worker
is not handed the Claude key.

Added for the acceptance checks on the laptop
([PHASE-2-ACCEPTANCE.md](PHASE-2-ACCEPTANCE.md)):

- The core times every spoken exchange from the release of the talk button
  (`voice.test.ts`, "times a spoken turn from the release of the talk
  button to the first sound").
- `apps/voice/tests/test_check.py`: the checks for a real microphone and
  real speakers, run in a room that exists only in the test, where the
  microphone hears the speaker a little later and quieter on a clock the
  test controls. They show that the arithmetic and the order of steps are
  right. **They say nothing about any real device.** The same file tests
  the summary of the latency figures (middle value, 90th percentile,
  slowest), and that the line it reads in the core's log is the line the
  core writes.
- `apps/voice/tests/test_bench.py`: the local model is measured at each
  context size asked for, against a stand-in for Ollama, and what did not
  fit on the GPU is reported.

Each piece of that logic was also switched off or changed once (19
changes). Three were not noticed at first; the tests were tightened until
every one of the 19 made a test fail.

**Real runs on the Mac:**

- A five-turn conversation through the whole HELIOS loop with `qwen3.5:4b`:
  it read the task list through tools, answered correctly, asked for
  confirmation before adding a task (with the right date for "next
  Friday"), and reported which model answered and the cloud spending.
  Answers took 0.2 to 1.5 seconds.
- The real speech models end to end in memory: HELIOS's voice was
  synthesised and fed back in as if from the microphone; both recognisers
  transcribed it word for word.
- The core's real child-process connection to the real Python worker.
- Push-to-talk in a browser against that worker (with scripted engines).
- The model commands on a copy of the installed models: `download` found
  everything in place and fetched nothing; with one byte changed in the
  speech detector, `verify` named the file and the real engine refused to
  load it; with a file removed, the engine named the command that fetches
  it.
- One real download of every set (`download --all`) from the release
  pages into an empty scratch folder: ten downloads, 1,846 MB, a little
  over six minutes on the connection used. Every download and every
  archive member matched the list. `verify` passed, the 19 files were
  byte for byte the installed ones, and nothing else was left in the
  folder. All 54 voice tests then passed on the downloaded files, and the
  two sets the tests do not load (the full-precision voice and the
  streaming recogniser) were run by hand: one synthesised a sentence and
  the other transcribed it word for word.

**Not tested, and why:**
- **A real microphone and real speakers.** The commands that measure them
  now exist (`helios_voice.check`, below), but of those only the listing of
  devices has run on real hardware. The worker lists the Mac's
  devices correctly (two microphones, two speakers). Opening the
  microphone did not return: macOS was waiting for an answer to its
  permission dialog, and nobody was there to give it. (That exposed a
  weakness, now fixed and tested: the worker gives up after five seconds
  and reports it, instead of freezing.) Speech was not played out loud
  unattended at night. So recording, room acoustics, the speaker-to-
  microphone feedback test and echo cancellation are all still open.
- **Claude.** No API key exists on this machine.
- **Everything on Windows.**

## Measurements (Mac, CPU for all speech models)

Each model was measured alone in a fresh process. Test speech was
synthetic (Kokoro, in voices other than HELIOS's), so the recognition
figures are an upper bound: a person two metres from a laptop microphone
will do worse.

| Model | Loads in | Speed | Memory | Idle CPU |
|---|---|---|---|---|
| Kokoro int8 | 0.24 s | first sentence 0.74 s cold, 0.30 s warm; 16 times faster than real time | 398 MB | 2% |
| Kokoro full precision | 0.26 s | first sentence 0.98 s cold, 0.54 s warm; 9.5 times faster than real time | 669 MB | 3% |
| Parakeet Unified, non-streaming | 0.65 s | 24 ms per second of audio | 1,889 MB | 2% |
| Parakeet TDT v2 | 0.62 s | 23 ms per second of audio | 1,882 MB | 3% |
| Parakeet Unified, streaming 560 ms | 0.67 s | first words after 1.1 s of speech | 1,678 MB | not measured |
| Silero VAD | 0.02 s | 3 ms per second of audio | 34 MB | not measured |
| openWakeWord (stock model) | 1.0 s | 19 ms per second of audio | 185 MB | 0% |
| `qwen3.5:4b` at 8,192 tokens of context | 0.5 s | 134 tokens per second; a short answer in 0.33 s | 4,228 MB, all on the GPU | not measured |

Recognition on ten synthetic sentences (94 words):

| Condition | Parakeet Unified | Parakeet TDT v2 |
|---|---|---|
| Clean | 5 words differ | 5 words differ |
| White noise, speech 10 dB louder | 6 | 5 |
| White noise as loud as the speech | 5 | 8 |
| A second voice, 10 dB quieter | 5 | 5 |

Of the five differences on clean speech, four are numbers written as
digits ("three" as "3", "forty two by eighteen" as "42 by 18") and one is
a real mistake ("shop" heard as "sharp").

Listening and speaking at the same moment barely slowed either down
(recognition 117 ms alone, 133 ms together; synthesis 302 ms and 305 ms),
and both models loaded together took 2,201 MB.

The stock wake model scored 0.999 on its own phrase, also with noise, and
0.0 on all ten other sentences.

The "Loads in" figures were taken before model files were checked on
loading. The check hashes each file first. Measured afterwards on the same
Mac, in fresh processes, five runs each, without and with the check:
Parakeet Unified 0.66 s and 0.88 s, Kokoro int8 0.16 s and 0.20 s, Silero
VAD 0.01 s either way. (That comparison does not count importing the
speech libraries, so its figures are not the table's.) The extra time is
paid once per start of the worker, the first time each model is used.

**What this suggests for the laptop, to be checked there:** the speech
models need about 2.5 GB of ordinary memory and no GPU memory, which
leaves the 8 GB of GPU memory to the language model and the 3D brain. The
language model took 4.2 GB on the Mac; the laptop uses a different runner,
so its figure is unknown. The two Parakeet exports each take almost 2 GB,
so only one should be loaded at a time.

## Routing: which model answers

Fixed rules in `apps/core/src/ai/policy.ts`. The same request always takes
the same route, and the reason is stored with the answer and shown under
it on screen. HELIOS can also be asked ("which model answered that?").

1. You asked for stronger reasoning ("think hard", "use the stronger
   model", or the screen's "Think hard" option): the strong cloud model.
2. The request is long (over 600 characters) or analytical (compare,
   analyse, trade-offs, strategy, step by step, and similar): the strong
   cloud model.
3. Everything else: the local model.
4. No local model running: the light cloud model.

Background work (extraction, summaries) goes to the light cloud model,
then the local one. A model that fails is skipped for the rest of that
turn and the next allowed one answers.

A cloud model is used only when all of these hold: cloud use is switched
on (`ai.cloud.enabled`); this month's budget has room; nothing labelled
secret is involved; and nothing labelled sensitive is involved, or you
approved sending exactly that conversation. When a rule blocks the cloud,
the local model answers and the reason says so. Tool results and recalled
memory carry their labels with them. Input that looks like a password or
key is labelled secret and shown to no model.

## Budget and cost

- Counted in euros, kept in the database, so it survives restarts.
- Prices are in US dollars. One dollar is counted as one euro, plus 21% for
  VAT and billing differences. The real bill should come out lower.
- Before each cloud call the most it can cost is set aside (the whole
  prompt plus the full answer allowance: 8,000 tokens for Sonnet, 2,000 for
  Haiku). If that does not fit under the cap, the call is not made. After
  the call the reservation is replaced by the real cost.
- A warning at €15, shown once a month. A hard stop at €20, after which
  the local model answers and says why.
- If the core dies during a call, that call is counted at its full
  estimate.

| Model | Input, per million tokens | Output, per million tokens |
|---|---|---|
| `claude-sonnet-5-5` | $2.00 | $10.00 |
| `claude-haiku-5-5` | $0.10 (prompts up to 100,000 tokens; $0.50 above) | $0.50 ($2.50 above) |

**What it is likely to cost** (worked out from the prices above, not
measured): a typical Sonnet answer with HELIOS's instructions and tools is
about 1,500 tokens in and 300 out, which is $0.006, counted here as
€0.007. Twenty such answers a day is about €4.50 a month. A million tokens
of background reading by Haiku is $0.10. Local answers cost nothing. On
those figures the €20 cap is not reached in normal use; the reservation
rule means the last €0.10 or so of the cap is never spent.

A Claude subscription does not include API use. An API key and its billing
are set up separately at console.anthropic.com, and a spending limit can be
set there too, as a second lock.

## How voice is built

```
 screen: hold-to-talk ──► core ──► voice worker (apps/voice, Python)
                           ▲             │  microphone, speech detection,
                           │             │  Parakeet, Kokoro, speakers
        transcript, states └─────────────┘
```

- The core starts the worker as a child process and talks to it over its
  standard input and output, one JSON object per line. The protocol is
  listed in `apps/voice/helios_voice/protocol.py`.
- The worker only hears and speaks. What was heard becomes an ordinary
  conversation turn, so a spoken request has exactly the limits of a typed
  one. **A wake word or a voice is not authentication**: sensitive actions
  still need the on-screen approval or the password.
- Answers are spoken sentence by sentence while the model is still
  writing. When told to stop, the worker stops handing sound to the
  speakers within 50 ms, and pressing talk interrupts it. Sound it has
  already handed over is still played out: playing is ended with the sound
  library's `stop()`, which waits for it. How long that is on real devices
  has not been measured (check D1 of the acceptance page).
- Every spoken exchange is timed on the core's clock from the moment
  listening ended: to the transcript, to the model's first sentence, and to
  that sentence being handed to the speakers. The three figures are written
  to the core's log (durations only) and shown in the voice status.
- **Not answering itself.** While HELIOS speaks, and for half a second
  afterwards, the microphone is ignored for the wake word. A transcript
  that arrives right after speaking and matches what HELIOS just said is
  dropped. Real echo cancellation is not built: it needs the speaker signal
  as a reference, and is to be judged on the laptop with the TV speakers.
- Models load the first time they are needed. Each model file is compared
  with the recorded one first (see "Where models come from" below).
- The worker is started without the cloud key. It never calls a cloud
  model, and speech libraries from other projects run inside it, so the
  core does not pass `ANTHROPIC_API_KEY` on to it.
- A missing microphone, a broken speaker or a model that will not load is
  reported and survived. If the worker dies, the core restarts it after 1,
  2, 5, 15 and 30 seconds, then leaves it off and says so. The core, the
  data and the conversation are not affected.
- States sent to the screen: `idle`, `listening`, `transcribing`,
  `thinking`, `retrieving`, `speaking`, `acting`, `presenting`, `error`.
- Words never go to the log, in the worker or the core.

## The wake phrase

What exists: wake-word mode with on and off, an adjustable threshold,
suppression while HELIOS speaks, and push-to-talk alongside it. It was
tested with openWakeWord's stock "hey jarvis" model.

What does not exist: a "Hey Helios" model. openWakeWord has no such model;
one has to be trained. As far as could be established without doing it:

- Training uses thousands of synthetic recordings of the phrase, made with
  the Piper voice generator, mixed with background sound and room echo,
  against a large set of other speech and noise.
- The project's own notebook runs on a free Google Colab GPU; Home
  Assistant describes training a basic model in about an hour. One
  community setup downloads roughly 20 GB of training data.
- Results vary: users report models that range from good to poor. A
  trained model has to be tested for false alarms against hours of TV and
  room sound before it is trusted.

None of those figures were verified here. Until a model is trained and
tested, push-to-talk is the way to talk to HELIOS.

## Where models come from and where they live

Speech models are downloaded from the projects' own release pages into the
`models` folder of the data folder (never the repository, and not part of
snapshots, because they can be downloaded again).

**The list.** `apps/voice/helios_voice/models.json` names every model
file: its address, its size and its SHA-256. For an archive it names the
archive and each file taken out of it. The list is the only place that
decides which file is the right one, so changing a model is a change to
the list, in a commit. It was built from three records that had to agree:
the files installed on the Mac, the checksums written down when they were
first downloaded, and what GitHub publishes about each release file. A
real download of every file on 15 November 2026 then matched it.

**The command**, from `apps/voice`:

```bash
uv run python -m helios_voice.models
```

```bash
uv run python -m helios_voice.models download
```

```bash
uv run python -m helios_voice.models verify
```

The first shows what is installed. `download` fetches what HELIOS needs
with its default settings and does not have: both recognisers, the speech
detector and the int8 voice, about 1,050 MB. `download --all` adds the
optional sets (the full-precision voice, the streaming recogniser, the wake
word), about 1,850 MB in all; `download kokoro-full wake-word` fetches sets
by name. `verify` re-reads every installed file and fails if one is not
the listed file or if something HELIOS needs is missing. The command
itself uses only Python's standard library.

**The rules it keeps:**

- A download is written to a side folder and hashed on the way. Only a
  file with the recorded size and SHA-256 is moved into the models folder.
  Anything else is deleted and reported, and nothing is installed from it.
- An archive is opened only after its own hash matched. Only the members
  named in the list are taken out, each to a place the program chose and
  each compared with its own hash. The archive is deleted afterwards.
- What is already in place and intact is not fetched again, so the command
  can be repeated after a failure. A damaged file is replaced.
- The worker compares a model file with the list each time it loads one. A
  file that is missing or changed is not loaded; the error names the file
  and the command that fetches it.
- A file the list does not know (a wake model trained later, for example)
  has nothing to be compared with and is loaded as it is.

The release pages are not fixed: their owners can replace a file under the
same name. (GitHub lists the Parakeet TDT archive as uploaded on 7 November
2026, eight days before it was recorded here.) When a file is replaced the
download is refused, on purpose. The new file then has to be looked at and
the list changed by hand.

The `SHA256SUMS` file that an earlier session left in the models folder is
no longer used.

| File | Source | Size |
|---|---|---|
| `sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming` | github.com/k2-fsa/sherpa-onnx, release `asr-models` | 478 MB |
| `sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-560ms` | same | 478 MB |
| `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` | same | 460 MB |
| `silero_vad.onnx` | same | 0.6 MB |
| `kokoro-v1.0.int8.onnx`, `kokoro-v1.0.onnx`, `voices-v1.0.bin` | github.com/thewh1teagle/kokoro-onnx, release `model-files-v1.0` | 96 MB, 321 MB, 27 MB |
| `melspectrogram.onnx`, `embedding_model.onnx`, `hey_jarvis_v0.1.onnx` | github.com/dscripka/openWakeWord, release `v0.5.1` | about 1 MB each |

## Setting it up

1. **Ollama**, version 0.19 or newer, then `ollama pull qwen3.5:4b`.
   On the development Mac the installed Ollama was 0.18.3, which refuses
   this model; update it from its menu.
2. **uv** (the Python tool), then in `apps/voice`: `uv sync --extra wake`.
   This installs Python 3.12 and the speech packages. Only Windows and
   macOS are supported, because openWakeWord 0.6.0 asks for a Linux-only
   package that has no build for Python 3.12.
3. **Speech models**: in `apps/voice`, run
   `uv run python -m helios_voice.models download`, then
   `uv run python -m helios_voice.models verify`. Add `--all` to the first
   for the wake word, the full-precision voice and the streaming
   recogniser.
4. **An Anthropic API key** in the environment as `ANTHROPIC_API_KEY`
   before starting the core. Protected storage for the key is still to do.
5. In `config.json` in the data folder set `"voice": { "enabled": true }`
   and start the core. The status line on screen shows the model, and a
   "Hold to talk" button appears.

Useful commands, from `apps/voice`:

```bash
uv run pytest
```

```bash
uv run python -m helios_voice.audition
```

```bash
uv run python -m helios_voice.bench --out results.json --ollama http://127.0.0.1:11434
```

```bash
uv run python -m helios_voice.check devices
```

The audition writes each male American voice saying the same four
sentences to the `voice-audition` folder next to the models (add `--play`
to hear them). The benchmark produces the figures in this page; with
`--context 8192 4096` it measures the local model at both sizes and says
how much of it is on the GPU and how much in ordinary memory.

`check` is for a real microphone and real speakers, with someone in the
room: `devices` lists them, `speaker` says one sentence, `mic` reports how
loud speech and the room are, `read` counts the words recognised from ten
sentences read aloud, and `echo` measures how late and how loud HELIOS's
own voice returns to the microphone and how long a stop takes. Each waits
for Enter before it listens or makes sound. `turns` needs no device: it
reads the core's log and gives the middle value, the 90th percentile and
the slowest of the last ten spoken exchanges. Add `--out FILE` to keep the
numbers; the file holds no words and no device names.

## Fallbacks

| If this fails | Then |
|---|---|
| Parakeet Unified will not load | Parakeet TDT v2 is loaded instead, and the log says so |
| A model file is missing or is not the listed file | It is not loaded. For Parakeet Unified the fallback above applies; otherwise an error state on screen, and the voice status names the file and the command that fetches it |
| The local model or Ollama is down | The light cloud model answers, if the rules allow; otherwise HELIOS says no model answered |
| The cloud is blocked (switch, budget, sensitive content) | The local model answers and the reason is shown |
| The voice worker dies | It is restarted; typing keeps working throughout |
| The microphone or speaker disappears | An error state on screen; the next press tries again |
| No wake model | Push-to-talk |

## Pending on the Windows laptop

Nothing here has been run on it. The checks that decide whether Phase 3
may begin, with the tool and the mark for each and the table their results
go into, are in [PHASE-2-ACCEPTANCE.md](PHASE-2-ACCEPTANCE.md): points 3
and 5 to 8 below are checks A, E, F, G and H3 there. To do, in this order:

1. `npm test` and `uv run pytest` pass on Windows.
2. `uv run python -m helios_voice.models download --all`, then `verify`:
   the first use of the download command on Windows (it has run once on
   the Mac). Then `uv run pytest` again: the tests that use the
   real models are skipped until the files are there. Note how long the
   check adds to the first use of each model on the Ryzen CPU.
3. `qwen3.5:4b` in Ollama on the RTX 4060: GPU memory at 4,096 and 8,192
   tokens of context, tokens per second, cold start, tool calls.
4. The benchmark above on the Ryzen CPU: load times, speed and memory of
   each speech model, and how they behave while the language model runs.
5. The laptop microphone at two metres: recognition quiet, and with TV
   sound; choose the non-streaming or the streaming export.
6. HELIOS speaking through the TV speakers: does the microphone pick it up
   enough to trigger anything, is the half-second guard enough, is echo
   cancellation needed.
7. Time from the end of speech to the first sound of the answer, local
   and cloud.
8. Killing Ollama and the voice worker while in use.
9. Idle load with everything running, for a machine that is always on.

## Sources

- [NVIDIA Parakeet Unified English 0.6B, model card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b)
- [sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases) and its [NeMo transducer models](https://csukuangfj.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html)
- [Home Assistant on training wake words](https://home-assistant.io/blog/2023/10/12/year-of-the-voice-chapter-4-wakewords)
- [piper-sample-generator](https://github.com/dscripka/piper-sample-generator)
- [Community notebooks for training openWakeWord models](https://community.home-assistant.io/t/colab-notebooks-to-train-your-custom-openwakeword-or-microwakeword/1026635)
