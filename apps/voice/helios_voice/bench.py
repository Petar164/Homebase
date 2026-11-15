"""Measures the speech models, and optionally the local language model, on
this machine.

    uv run python -m helios_voice.bench --out results.json
    uv run python -m helios_voice.bench --ollama http://127.0.0.1:11434 --model qwen3.5:4b

Rules of this benchmark:
  - Every model is measured in its own fresh process, so the memory figure
    belongs to that model alone.
  - No microphone and no speakers are used. Test speech is synthesised by
    Kokoro in voices other than HELIOS's. Synthetic speech is cleaner than a
    person across a room, so recognition scores here are an upper bound.
  - Nothing is estimated. A measurement that could not be taken is reported
    as an error, not filled in.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np

from .audio import SAMPLE_RATE, resample

SENTENCES = [
    "What is due this week?",
    "Add a task to call the dentist next Friday at three.",
    "How much did the shop make in November?",
    "Remind me to send the invoice to the supplier tomorrow morning.",
    "What did I decide about the internship applications?",
    "Move the database assignment to Thursday and mark the weekly review as done.",
    "Think hard about this: should I raise prices on the archive pieces?",
    "Which model answered that, and what has the cloud cost this month?",
    "Stop. Never mind.",
    "Search my notes for the warehouse measurements, forty two by eighteen.",
]
SPEAKERS = ["am_adam", "af_heart", "bm_george"]  # not HELIOS's own voice
ANSWER = "Your focus for today is the database assignment, which is three days late. After that, photograph the new stock."


def rss_mb() -> float:
    import psutil

    return psutil.Process().memory_info().rss / (1024 * 1024)


def timed(work):
    started = time.perf_counter()
    result = work()
    return result, (time.perf_counter() - started) * 1000


def words(text: str) -> list[str]:
    return "".join(ch for ch in text.lower() if ch.isalnum() or ch.isspace()).split()


def word_errors(reference: str, heard: str) -> tuple[int, int]:
    """Edit distance between the two word lists, and the reference length."""
    ref, hyp = words(reference), words(heard)
    row = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        previous, row[0] = row[0], i
        for j, h in enumerate(hyp, 1):
            previous, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, previous + (r != h))
    return row[-1], len(ref)


def with_noise(speech: np.ndarray, snr_db: float, seed: int) -> np.ndarray:
    noise = np.random.default_rng(seed).standard_normal(len(speech)).astype(np.float32)
    scale = np.sqrt(np.mean(speech**2) / (10 ** (snr_db / 10))) / np.sqrt(np.mean(noise**2))
    return speech + noise * scale


def idle_cpu_percent(seconds: float = 3.0) -> float:
    import psutil

    process = psutil.Process()
    before = sum(process.cpu_times()[:2])
    time.sleep(seconds)
    return round((sum(process.cpu_times()[:2]) - before) / seconds * 100, 2)


# ---------- children: one model each ----------


def child_clips(out: str) -> dict:
    from .engines import KokoroTts

    tts = KokoroTts("int8")
    clips = {}
    for index, sentence in enumerate(SENTENCES):
        samples, rate = tts.synthesize(sentence, SPEAKERS[index % len(SPEAKERS)], 1.0)
        clips[f"s{index}"] = resample(samples, rate, SAMPLE_RATE)
    other, rate = tts.synthesize("In other news tonight, the weather will stay dry across the region.", "bf_emma", 1.0)
    clips["tv"] = resample(other, rate, SAMPLE_RATE)
    wake, rate = tts.synthesize("Hey Jarvis.", "am_adam", 1.0)
    clips["wake"] = resample(wake, rate, SAMPLE_RATE)
    np.savez(out, **clips)
    return {"clips": len(SENTENCES), "seconds": round(sum(len(clips[f"s{i}"]) for i in range(len(SENTENCES))) / SAMPLE_RATE, 1)}


def child_tts(model: str) -> dict:
    from .engines import KokoroTts, split_sentences

    before = rss_mb()
    engine, load_ms = timed(lambda: KokoroTts(model))
    first_sentence = split_sentences(ANSWER)[0]
    (samples, rate), first_ms = timed(lambda: engine.synthesize(first_sentence, "am_michael", 1.0))
    warm = [timed(lambda: engine.synthesize(first_sentence, "am_michael", 1.0))[1] for _ in range(5)]
    (long_samples, _), long_ms = timed(lambda: engine.synthesize(ANSWER, "am_michael", 1.0))
    return {
        "load_ms": round(load_ms),
        "first_sentence_cold_ms": round(first_ms),
        "first_sentence_warm_ms": round(statistics.median(warm)),
        "first_sentence_audio_s": round(len(samples) / rate, 2),
        "times_faster_than_real_time": round((len(long_samples) / rate) / (long_ms / 1000), 1),
        "memory_mb": round(rss_mb() - before),
        "idle_cpu_percent": idle_cpu_percent(),
    }


def child_stt(model: str, clips_path: str) -> dict:
    from .engines import ParakeetStt

    clips = np.load(clips_path)
    before = rss_mb()
    engine, load_ms = timed(lambda: ParakeetStt(model))
    _, cold_ms = timed(lambda: engine.transcribe(clips["s0"]))
    result: dict = {"load_ms": round(load_ms), "first_decode_cold_ms": round(cold_ms)}

    def run(transform) -> dict:
        errors = total = 0
        times = []
        for index, sentence in enumerate(SENTENCES):
            audio = transform(clips[f"s{index}"], index)
            heard, ms = timed(lambda: engine.transcribe(audio))
            times.append(ms / (len(audio) / SAMPLE_RATE))
            wrong, count = word_errors(sentence, heard)
            errors, total = errors + wrong, total + count
        return {"word_error_percent": round(errors / total * 100, 1), "ms_per_second_of_audio": round(statistics.median(times), 1)}

    def tv(audio: np.ndarray, _index: int) -> np.ndarray:
        other = np.resize(clips["tv"], len(audio))
        return audio + other * 0.3  # another voice in the room, about 10 dB quieter

    result["clean"] = run(lambda audio, _i: audio)
    result["noise_snr_10db"] = run(lambda audio, i: with_noise(audio, 10, i))
    result["noise_snr_0db"] = run(lambda audio, i: with_noise(audio, 0, i))
    result["second_voice_10db_quieter"] = run(tv)
    result["memory_mb"] = round(rss_mb() - before)
    result["idle_cpu_percent"] = idle_cpu_percent()
    return result


def child_stream(clips_path: str) -> dict:
    """The streaming export of Parakeet Unified: does it run, and when do the first words arrive?"""
    import sherpa_onnx

    from .models import checked, models_dir

    clips = np.load(clips_path)
    folder = models_dir() / "stt" / "sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-560ms"
    before = rss_mb()
    recognizer, load_ms = timed(
        lambda: sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=checked(folder / "tokens.txt"),
            encoder=checked(folder / "encoder.int8.onnx"),
            decoder=checked(folder / "decoder.int8.onnx"),
            joiner=checked(folder / "joiner.int8.onnx"),
            num_threads=4,
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
        )
    )
    errors = total = 0
    first_words_at = []
    for index, sentence in enumerate(SENTENCES):
        audio = np.concatenate([clips[f"s{index}"], np.zeros(SAMPLE_RATE, dtype=np.float32)])
        stream = recognizer.create_stream()
        first = None
        for start in range(0, len(audio), 1600):  # 100 ms at a time, as a microphone delivers it
            stream.accept_waveform(SAMPLE_RATE, audio[start : start + 1600])
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            if first is None and recognizer.get_result(stream).strip():
                first = (start + 1600) / SAMPLE_RATE
        stream.input_finished()
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        wrong, count = word_errors(sentence, recognizer.get_result(stream))
        errors, total = errors + wrong, total + count
        if first is not None:
            first_words_at.append(first)
    return {
        "load_ms": round(load_ms),
        "word_error_percent": round(errors / total * 100, 1),
        "first_words_after_s_of_audio": round(statistics.median(first_words_at), 2) if first_words_at else None,
        "memory_mb": round(rss_mb() - before),
    }


def child_vad(clips_path: str) -> dict:
    from .engines import SileroVad

    clips = np.load(clips_path)
    before = rss_mb()
    vad, load_ms = timed(SileroVad)
    silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
    audio = np.concatenate([silence, clips["s1"], silence, silence])
    speech, ms = timed(lambda: vad.trim(audio))
    return {
        "load_ms": round(load_ms),
        "ms_per_second_of_audio": round(ms / (len(audio) / SAMPLE_RATE), 2),
        "kept_s_of": [round(len(speech) / SAMPLE_RATE, 2), round(len(audio) / SAMPLE_RATE, 2)],
        "silence_gives_no_speech": len(vad.trim(np.zeros(SAMPLE_RATE * 3, dtype=np.float32))) == 0,
        "memory_mb": round(rss_mb() - before),
    }


def child_wake(clips_path: str) -> dict:
    from .engines import OpenWakeWord

    clips = np.load(clips_path)
    before = rss_mb()
    wake, load_ms = timed(lambda: OpenWakeWord("hey_jarvis_v0.1.onnx"))
    pad = np.zeros(SAMPLE_RATE, dtype=np.float32)

    def best(audio: np.ndarray) -> float:
        wake.reset()
        padded = np.concatenate([pad, audio, pad])
        return round(max(wake.score(padded[start : start + 1600]) for start in range(0, len(padded), 1600)), 3)

    ten_seconds = np.resize(clips["s5"], SAMPLE_RATE * 10)
    _, ms = timed(lambda: best(ten_seconds))
    others = [best(clips[f"s{index}"]) for index in range(len(SENTENCES))]
    return {
        "model": "hey_jarvis (stock model, used to test the wiring; 'Hey Helios' is not trained)",
        "load_ms": round(load_ms),
        "ms_per_second_of_audio": round(ms / 12, 2),
        "score_on_its_phrase": best(clips["wake"]),
        "highest_score_on_ten_other_sentences": max(others),
        "score_on_its_phrase_with_noise_snr_10db": best(with_noise(clips["wake"], 10, 1)),
        "memory_mb": round(rss_mb() - before),
        "idle_cpu_percent": idle_cpu_percent(),
    }


def child_together(clips_path: str) -> dict:
    """Recognising and synthesising at the same moment, as when the owner interrupts."""
    from .engines import KokoroTts, ParakeetStt, split_sentences

    clips = np.load(clips_path)
    before = rss_mb()
    stt, tts = ParakeetStt("parakeet-unified"), KokoroTts("int8")
    sentence = split_sentences(ANSWER)[0]
    stt.transcribe(clips["s0"])
    tts.synthesize(sentence, "am_michael", 1.0)
    alone_stt = statistics.median(timed(lambda: stt.transcribe(clips["s5"]))[1] for _ in range(3))
    alone_tts = statistics.median(timed(lambda: tts.synthesize(sentence, "am_michael", 1.0))[1] for _ in range(3))
    measured = {}

    def run(name, work):
        measured[name] = statistics.median(timed(work)[1] for _ in range(3))

    threads = [threading.Thread(target=run, args=("stt", lambda: stt.transcribe(clips["s5"]))), threading.Thread(target=run, args=("tts", lambda: tts.synthesize(sentence, "am_michael", 1.0)))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return {
        "stt_alone_ms": round(alone_stt),
        "stt_while_speaking_ms": round(measured["stt"]),
        "tts_alone_ms": round(alone_tts),
        "tts_while_listening_ms": round(measured["tts"]),
        "both_models_memory_mb": round(rss_mb() - before),
    }


# ---------- the local language model, through Ollama ----------


def ollama(base: str, model: str) -> dict:
    def post(path: str, body: dict) -> dict:
        request = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.load(response)

    def chat(prompt: str) -> dict:
        body = {"model": model, "stream": False, "think": False, "options": {"num_ctx": 8192}, "messages": [{"role": "system", "content": "You are HELIOS. Answer in one or two short sentences."}, {"role": "user", "content": prompt}]}
        data, ms = timed(lambda: post("/api/chat", body))
        return {"total_ms": round(ms), "load_ms": round(data.get("load_duration", 0) / 1e6), "answer_tokens": data.get("eval_count"), "tokens_per_second": round(data.get("eval_count", 0) / max(data.get("eval_duration", 1) / 1e9, 1e-9), 1)}

    post("/api/generate", {"model": model, "keep_alive": 0})  # unload, so the first call shows a cold start
    cold = chat("Say good morning.")
    warm = [chat(prompt) for prompt in ("What should I do first today, in one sentence?", "Explain in two sentences why backups matter.", "Give me one short tip for staying focused.")]
    with urllib.request.urlopen(f"{base}/api/ps", timeout=30) as response:
        loaded = [entry for entry in json.load(response).get("models", []) if entry.get("name") == model]
    info = post("/api/show", {"model": model}).get("details", {})
    return {
        "model": model,
        "quantisation": info.get("quantization_level"),
        "parameters": info.get("parameter_size"),
        "context_tokens": 8192,
        "cold_start": cold,
        "warm": {"median_total_ms": round(statistics.median(entry["total_ms"] for entry in warm)), "median_tokens_per_second": round(statistics.median(entry["tokens_per_second"] for entry in warm), 1)},
        "loaded_size_mb": round(loaded[0]["size"] / 1048576) if loaded else None,
        "of_which_on_gpu_mb": round(loaded[0].get("size_vram", 0) / 1048576) if loaded else None,
    }


# ---------- the parent ----------

CHILDREN = {
    "tts_int8": lambda clips: child_tts("int8"),
    "tts_full": lambda clips: child_tts("full"),
    "stt_parakeet_unified": lambda clips: child_stt("parakeet-unified", clips),
    "stt_parakeet_tdt_v2": lambda clips: child_stt("parakeet-tdt-v2", clips),
    "stt_parakeet_unified_streaming_560ms": child_stream,
    "speech_detection_silero": child_vad,
    "wake_openwakeword": child_wake,
    "listening_and_speaking_together": child_together,
}


def run_child(name: str, clips: str) -> dict:
    completed = subprocess.run([sys.executable, "-m", "helios_voice.bench", "--child", name, "--clips", clips], capture_output=True, text=True, timeout=900)
    for line in reversed(completed.stdout.splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    return {"error": (completed.stderr.strip().splitlines() or ["no output"])[-1][:300]}


def main() -> None:
    parser = argparse.ArgumentParser(prog="helios_voice.bench")
    parser.add_argument("--child")
    parser.add_argument("--clips", default="")
    parser.add_argument("--out", default="")
    parser.add_argument("--ollama", default="")
    parser.add_argument("--model", default="qwen3.5:4b")
    args = parser.parse_args()

    if args.child:
        try:
            result = child_clips(args.clips) if args.child == "clips" else CHILDREN[args.child](args.clips)
        except Exception as error:
            result = {"error": f"{type(error).__name__}: {error}"[:300]}
        sys.stdout = sys.__stdout__
        print(json.dumps(result))
        return

    import psutil

    with tempfile.TemporaryDirectory() as folder:
        clips = str(Path(folder) / "clips.npz")
        results: dict = {
            "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "machine": {"system": f"{platform.system()} {platform.release()}", "processor": platform.processor() or platform.machine(), "cpu_cores": os.cpu_count(), "ram_gb": round(psutil.virtual_memory().total / 1073741824), "python": platform.python_version()},
            "note": "Speech is synthetic (Kokoro, voices other than HELIOS's) and no audio device is used. All speech models run on the CPU.",
            "test_speech": run_child("clips", clips),
        }
        for name in CHILDREN:
            print(f"measuring {name} ...", file=sys.stderr, flush=True)
            results[name] = run_child(name, clips)
    if args.ollama:
        print("measuring the local language model ...", file=sys.stderr, flush=True)
        try:
            results["local_language_model"] = ollama(args.ollama.rstrip("/"), args.model)
        except Exception as error:
            results["local_language_model"] = {"error": f"{type(error).__name__}: {error}"[:300]}

    text = json.dumps(results, indent=2)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
