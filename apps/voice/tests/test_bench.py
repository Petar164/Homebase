"""The benchmark's measurement of the local language model, against a
stand-in for Ollama on this machine. No model and no Ollama are needed."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from helios_voice import bench


class StandInOllama:
    """Answers the four requests the benchmark makes, and remembers them."""

    def __init__(self) -> None:
        self.asked: list[tuple[str, dict]] = []
        self.fail_at_context: int | None = None
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

            def reply(self, body: dict, status: int = 200) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                outer.asked.append((self.path, {}))
                self.reply({"models": [{"name": "test-model", "size": 4200 * 1048576, "size_vram": 3900 * 1048576}]})

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.asked.append((self.path, body))
                if self.path == "/api/chat":
                    if body["options"]["num_ctx"] == outer.fail_at_context:
                        return self.reply({"error": "out of memory"}, 500)
                    return self.reply({"load_duration": 400_000_000, "eval_count": 30, "eval_duration": 250_000_000})
                if self.path == "/api/show":
                    return self.reply({"details": {"quantization_level": "Q4", "parameter_size": "4.5B"}})
                self.reply({})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def stand_in():
    ollama = StandInOllama()
    yield ollama
    ollama.server.shutdown()
    ollama.server.server_close()


def test_the_local_model_is_measured_at_each_context_size_asked_for(stand_in):
    results = bench.local_model(stand_in.base, "test-model", [8192, 4096])

    assert list(results) == ["local_language_model", "local_language_model_at_4096_tokens"]  # the one HELIOS uses keeps the old name
    assert [results[name]["context_tokens"] for name in results] == [8192, 4096]
    first = results["local_language_model"]
    assert first["warm"]["median_tokens_per_second"] == 120.0 and first["cold_start"]["load_ms"] == 400
    assert (first["loaded_size_mb"], first["of_which_on_gpu_mb"], first["quantisation"]) == (4200, 3900, "Q4")
    assert first["of_which_in_ordinary_memory_mb"] == 300  # what did not fit on the GPU is said outright

    chats = [body["options"]["num_ctx"] for path, body in stand_in.asked if path == "/api/chat"]
    assert chats == [8192] * 4 + [4096] * 4  # every question at its own size
    unloads = [index for index, (path, body) in enumerate(stand_in.asked) if path == "/api/generate" and body.get("keep_alive") == 0]
    assert len(unloads) == 2 and unloads[0] == 0  # unloaded before each size, so the memory figure is that size's own


def test_a_context_size_that_fails_is_reported_and_the_others_still_measured(stand_in):
    stand_in.fail_at_context = 8192
    results = bench.local_model(stand_in.base, "test-model", [8192, 4096])
    assert "error" in results["local_language_model"] and results["local_language_model"]["context_tokens"] == 8192
    assert results["local_language_model_at_4096_tokens"]["warm"]["median_tokens_per_second"] == 120.0
