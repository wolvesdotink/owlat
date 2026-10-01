"""HTTP front of the local decision engine.

Three routes, no auth, and no published port: like the bundled `ollama`
service, this listens only on the internal Docker network and the Convex
backend is its one client.

    GET  /health       200 once the model is loaded, 503 while it loads
    GET  /v1/models    {"data": [{"id": <model>, "revision": ...}]}
    POST /v1/decide    the decision wire, see `decide.py`

The model loads on a background thread so the container answers /health
straight away; if the load fails the process exits and Docker restarts it. A decision asked before the model is ready gets 503 with a
Retry-After, which the Convex dispatch treats as retriable. The first start
downloads the checkpoint into the model volume (around 1.1 GB for the default
model), so that can take a while; later starts read it from disk.

Inference runs one request at a time behind a lock. torch already spreads one
forward pass over the CPU cores, and a second concurrent pass would only make
both slower.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from decide import DecisionRequestError, ModelNotServedError, decide

log = logging.getLogger("decision-local")

MAX_BODY_BYTES = 2 * 1024 * 1024
LOADING_RETRY_AFTER_SECONDS = 10


class EngineState:
    """The engine plus what the server needs to report about it."""

    def __init__(self, engine: Any, on_load_failure: Callable[[], None] | None = None) -> None:
        self.engine = engine
        self.lock = threading.Lock()
        self.error: str | None = None
        self.on_load_failure = on_load_failure

    def load_in_background(self) -> threading.Thread:
        def run() -> None:
            try:
                self.engine.load()
            except Exception as exc:  # noqa: BLE001 - reported on /health
                log.exception("model load failed")
                self.error = f"{type(exc).__name__}: {exc}"
                if self.on_load_failure is not None:
                    self.on_load_failure()

        thread = threading.Thread(target=run, name="model-load", daemon=True)
        thread.start()
        return thread


def make_handler(state: EngineState) -> Callable[..., BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "owlat-decision-local"
        sys_version = ""

        def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
            # Request lines only; bodies carry message text and are never logged.
            log.info("%s %s", self.address_string(), fmt % args)

        def _send(self, status: int, payload: Any, headers: dict[str, str] | None = None) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
            self._send(status, {"error": {"message": message}}, headers)

        def _not_ready(self) -> None:
            if state.error is not None:
                self._error(HTTPStatus.SERVICE_UNAVAILABLE, f"The model failed to load: {state.error}")
            else:
                self._error(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    f"The model {state.engine.model_id} is still loading.",
                    {"retry-after": str(LOADING_RETRY_AFTER_SECONDS)},
                )

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                if state.engine.ready:
                    self._send(HTTPStatus.OK, {"status": "ok", "model": state.engine.model_id})
                else:
                    self._not_ready()
                return
            if self.path == "/v1/models":
                self._send(
                    HTTPStatus.OK,
                    {
                        "data": [
                            {
                                "id": state.engine.model_id,
                                "revision": state.engine.revision,
                                "ready": state.engine.ready,
                            }
                        ]
                    },
                )
                return
            self._error(HTTPStatus.NOT_FOUND, f"No route {self.path}.")

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/decide":
                self._error(HTTPStatus.NOT_FOUND, f"No route {self.path}.")
                return
            try:
                length = int(self.headers.get("content-length") or "0")
            except ValueError:
                self._error(HTTPStatus.BAD_REQUEST, "Invalid content-length.")
                return
            if length <= 0:
                self._error(HTTPStatus.BAD_REQUEST, "The request has no body.")
                return
            if length > MAX_BODY_BYTES:
                self._error(
                    HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                    f"The request body is over {MAX_BODY_BYTES} bytes.",
                )
                return
            try:
                body = json.loads(self.rfile.read(length))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._error(HTTPStatus.BAD_REQUEST, "The request body is not JSON.")
                return
            if not state.engine.ready:
                self._not_ready()
                return
            try:
                with state.lock:
                    result = decide(body, state.engine.score, state.engine.model_id)
            except DecisionRequestError as exc:
                self._error(HTTPStatus.UNPROCESSABLE_ENTITY, str(exc))
                return
            except ModelNotServedError as exc:
                self._error(HTTPStatus.NOT_FOUND, str(exc))
                return
            except Exception:  # noqa: BLE001
                log.exception("decision failed")
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "The engine failed to answer.")
                return
            self._send(HTTPStatus.OK, result)

    return Handler


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    from engine import Engine

    # A failed load (no network on the first download, a typo in
    # DECISION_LOCAL_MODEL) exits, so the restart policy retries it with
    # backoff instead of leaving a container that answers 503 forever.
    state = EngineState(Engine(), on_load_failure=lambda: os._exit(1))
    state.load_in_background()
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(state))
    log.info("listening on :%d", port)
    server.serve_forever()


if __name__ == "__main__":
    main()
