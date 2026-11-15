# AI and voice stack

Which models HELIOS uses, how they are run, what they cost, and what has
actually been tested. This page separates three things on purpose:
**verified on the Mac** (the development machine), **written but not yet
run**, and **pending on the Windows laptop** (the machine HELIOS will live
on). Nothing here is a Windows result yet.

Status: work in progress on the branch `feature/ai-voice-stack`.

## The stack

| Job | Model | Runs through | State |
|---|---|---|---|
| Everyday reasoning, Home Base questions | `qwen3.5:4b` | Ollama, on this machine | Tag exists; needs Ollama newer than 0.18.3. First real run pending |
| Hard reasoning, planning, analysis | `claude-sonnet-5-5` | Anthropic API | Connection written and tested against a fake. No real call yet: there is no API key |
| Extraction, classification, summaries, background work | `claude-haiku-5-5` | Anthropic API | Same |
| Speech to text | NVIDIA Parakeet Unified English 0.6B, int8 | sherpa-onnx 2.0.1, on the CPU | **Runs on the Mac.** Transcribed a synthesised test sentence exactly |
| Speech to text, fallback | Parakeet TDT 0.6B v2, int8 | sherpa-onnx 2.0.1, on the CPU | **Runs on the Mac.** Same result on the same sentence |
| Speech detection | Silero VAD | sherpa-onnx | Downloaded, not yet run |
| HELIOS's voice | Kokoro 82M, voice `am_michael` | kokoro-onnx 0.6.1, on the CPU | **Runs on the Mac** |
| Wake phrase | openWakeWord 0.6.0 | onnxruntime | Installed. "Hey Helios" does not exist as a model yet and needs training |

Model names, context size, effort and prices are settings in `config.json`
in the data folder (section `ai`), not code.

## Findings so far

**The preferred speech model is available in the form that was hoped for.**
The sherpa-onnx project publishes official int8 exports of
`nvidia/parakeet-unified-en-0.6b`: one non-streaming, and three streaming
ones with different chunk sizes (240, 560 and 1120 ms). Support arrived in
sherpa-onnx 1.13.4. The non-streaming export loads with
`OfflineRecognizer.from_transducer(..., model_type="nemo_transducer")`.
The streaming exports have not been run yet.

**`qwen3.5:4b` needs a newer Ollama than the one installed on the Mac.**
Ollama 0.18.3 refuses the download and points to the download page. The
current release is 0.40.16. For testing, that release is run separately on
another port, so the installed Ollama is untouched. To use the model for
real on the Mac, update Ollama. On the laptop a fresh install is current
anyway.

**openWakeWord's dependencies are ageing.** Version 0.6.0 (February 2024)
asks for a Linux-only package that has no build for Python 3.12. The voice
worker's install is therefore limited to Windows and macOS, where it is not
needed.

## First measurements (Mac, Apple M5 Max, CPU only, one run each)

These are a first contact, not a benchmark: one sentence, one run, all
models loaded in one process. Proper measurements, one model per process,
come with the benchmark step. They say nothing about the laptop.

| What | Result |
|---|---|
| Kokoro int8, 5.7 s of speech | loads in 0.3 s; first sentence 0.8 s; then 0.4 s (about 15 times faster than real time) |
| Kokoro full precision, same sentence | loads in 0.2 s; 0.65 s (about 9 times faster than real time) |
| Parakeet Unified int8, non-streaming, 5.7 s of speech | loads in 0.7 s; transcribes in 0.13 s; text exactly right, with punctuation |
| Parakeet TDT v2 int8, same audio | loads in 0.7 s; transcribes in 0.12 s; text exactly right |

Male American Kokoro voices available for the audition: `am_adam`,
`am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`,
`am_puck`, `am_santa`.

## Where models come from and where they live

Speech models are downloaded from the projects' own release pages and kept
in the `models` folder of the data folder (never in the repository, and not
part of snapshots, because they can be downloaded again).

| File | Source | Size |
|---|---|---|
| `sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-non-streaming` | github.com/k2-fsa/sherpa-onnx, release `asr-models` | 478 MB |
| `sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-560ms` | same | 478 MB |
| `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` | same | 460 MB |
| `silero_vad.onnx` | same | 0.6 MB |
| `kokoro-v1.0.int8.onnx`, `kokoro-v1.0.onnx`, `voices-v1.0.bin` | github.com/thewh1teagle/kokoro-onnx, release `model-files-v1.0` | 96 MB, 321 MB, 27 MB |
| `melspectrogram.onnx`, `embedding_model.onnx`, `hey_jarvis_v0.1.onnx` | github.com/dscripka/openWakeWord, release `v0.5.1` | about 1 MB each |

A SHA-256 of every downloaded file is recorded in `SHA256SUMS` in the
models folder. Pinning those hashes in the worker is still to do.

## Routing: which model answers

Fixed rules, in `apps/core/src/ai/policy.ts`. The same request always takes
the same route, and the reason is stored with the answer.

1. You asked for stronger reasoning ("think hard", "use the stronger
   model", or the screen's option): the strong cloud model.
2. The request is long (over 600 characters) or analytical (compare,
   analyse, trade-offs, strategy, step by step, and similar): the strong
   cloud model.
3. Everything else: the local model.
4. No local model running: the light cloud model.

Background work (extraction, summaries) goes to the light cloud model, then
the local one.

A cloud model is used only when all of these hold: cloud use is switched on
(`ai.cloud.enabled`); this month's budget has room; nothing labelled secret
is involved; and nothing labelled sensitive is involved, or you approved
sending exactly that conversation. When a rule blocks the cloud, the local
model answers and the reason says so. Anything labelled secret is withheld
from every model, the local one included.

## Budget

- Counted in euros, kept in the database, so it survives restarts.
- Prices are in US dollars. One dollar is counted as one euro, plus 21% for
  VAT and billing differences. The real bill should come out lower.
- Before each cloud call the most it can cost is set aside (the whole prompt
  plus the full answer allowance: 8,000 tokens for Sonnet, 2,000 for Haiku).
  If that does not fit under the cap, the call is not made. After the call
  the reservation is replaced by the real cost.
- Warning at €15, shown once a month. Hard stop at €20.
- If the core dies during a call, that call is counted at its full estimate.

| Model | Input, per million tokens | Output, per million tokens |
|---|---|---|
| `claude-sonnet-5-5` | $2.00 | $10.00 |
| `claude-haiku-5-5` | $0.10 (prompts up to 100,000 tokens; $0.50 above) | $0.50 ($2.50 above) |

A Claude subscription does not include API use. An API key and its billing
are set up separately at console.anthropic.com.

## Still to build in this work

- A real run of `qwen3.5:4b`: quantisation, memory, speed, and whether it
  calls tools reliably.
- The voice worker (`apps/voice`): microphone, Silero VAD, Parakeet,
  Kokoro, push-to-talk, cancelling speech, device selection, recovery.
- The core's side: starting and supervising the worker, speech into the
  conversation, answers spoken sentence by sentence, the new states.
- Not answering its own voice: the microphone is ignored while HELIOS
  speaks. Real echo cancellation is to be investigated.
- Wake word plumbing with a stock model, and what training "Hey Helios"
  takes.
- The audition tool for comparing voices.
- Benchmarks, one model per process.

## Pending on the Windows laptop

Everything. In particular: GPU memory with the local model loaded, speech
models on that CPU, the laptop microphone at two metres with TV sound,
feedback from the TV speakers, time from end of speech to first audio, and
behaviour when Ollama or the voice worker is killed.
