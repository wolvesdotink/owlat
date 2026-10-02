import http.client
import json
import os
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import DEADLINE_HEADER, EngineState, make_handler  # noqa: E402

MODEL = "fastino/GLiNER2.5-multi-Decide"


class FakeEngine:
    model_id = MODEL
    revision = "abc"

    def __init__(self, ready=True, fail=False, gate=None):
        self.ready = ready
        self.fail = fail
        # When set, score() blocks until the gate opens, holding the one slot.
        self.gate = gate
        self.scoring = threading.Event()
        self.calls = 0

    def load(self):
        if self.fail:
            raise OSError("no network")
        self.ready = True

    def score(self, text, heads):
        self.calls += 1
        self.scoring.set()
        if self.gate is not None:
            self.gate.wait(5)
        return {head.name: {label.name: 1.0 for label in head.labels} for head in heads}, 3


DECIDE_BODY = {"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}}


class ServerTest(unittest.TestCase):
    def start(self, engine, **state_options):
        self.state = EngineState(engine, **state_options)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.state))
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        return self.server.server_address[1]

    def request(self, port, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request(
                "POST" if data is not None else "GET",
                path,
                body=data,
                headers={"content-type": "application/json", **(headers or {})},
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read()), response.headers
        finally:
            connection.close()

    def hold_slot(self, port, engine):
        """Start one request that occupies the inference slot until released."""
        thread = threading.Thread(target=self.request, args=(port, "/v1/decide", DECIDE_BODY))
        thread.start()
        self.assertTrue(engine.scoring.wait(5))
        return thread

    def test_health_and_models(self):
        base = self.start(FakeEngine())
        status, payload, _ = self.request(base, "/health")
        self.assertEqual((status, payload["model"]), (200, MODEL))
        status, payload, _ = self.request(base, "/v1/models")
        self.assertEqual(payload["data"][0]["id"], MODEL)

    def test_decides(self):
        base = self.start(FakeEngine())
        status, payload, _ = self.request(
            base,
            "/v1/decide",
            {"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["answers"]["q"], {"type": "noul", "noul": 0.5})
        self.assertEqual(payload["usage"], {"input_tokens": 3, "output_tokens": 0})

    def test_loading_is_retriable(self):
        base = self.start(FakeEngine(ready=False))
        status, _, headers = self.request(base, "/health")
        self.assertEqual(status, 503)
        status, payload, headers = self.request(
            base,
            "/v1/decide",
            {"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}},
        )
        self.assertEqual(status, 503)
        self.assertEqual(headers["retry-after"], "10")
        self.assertIn("still loading", payload["error"]["message"])

    def test_a_failed_load_is_reported(self):
        engine = FakeEngine(ready=False, fail=True)
        base = self.start(engine)
        with self.assertLogs("decision-local", level="ERROR"):
            self.state.load_in_background().join()
        status, payload, _ = self.request(base, "/health")
        self.assertEqual(status, 503)
        self.assertIn("no network", payload["error"]["message"])

    def test_a_request_whose_client_gave_up_never_reaches_the_model(self):
        gate = threading.Event()
        engine = FakeEngine(gate=gate)
        base = self.start(engine)
        holder = self.hold_slot(base, engine)
        started = time.monotonic()
        status, payload, headers = self.request(
            base, "/v1/decide", DECIDE_BODY, headers={DEADLINE_HEADER: "400"}
        )
        self.assertEqual(status, 503)
        self.assertEqual(headers["retry-after"], "1")
        self.assertIn("deadline", payload["error"]["message"])
        self.assertLess(time.monotonic() - started, 2)
        gate.set()
        holder.join(5)
        time.sleep(0.2)
        # Only the request that held the slot ever scored.
        self.assertEqual(engine.calls, 1)

    def test_a_full_queue_turns_the_next_request_away(self):
        gate = threading.Event()
        engine = FakeEngine(gate=gate)
        base = self.start(engine, max_queue=1)
        holder = self.hold_slot(base, engine)
        waiter = threading.Thread(target=self.request, args=(base, "/v1/decide", DECIDE_BODY))
        waiter.start()
        time.sleep(0.2)
        status, payload, _ = self.request(base, "/v1/decide", DECIDE_BODY)
        self.assertEqual(status, 503)
        self.assertIn("already waiting", payload["error"]["message"])
        gate.set()
        holder.join(5)
        waiter.join(5)
        # The holder and the one queued request ran; the third never did.
        self.assertEqual(engine.calls, 2)

    def test_a_request_without_a_deadline_still_waits_only_so_long(self):
        gate = threading.Event()
        engine = FakeEngine(gate=gate)
        base = self.start(engine, max_wait_seconds=0.3)
        holder = self.hold_slot(base, engine)
        status, _, _ = self.request(base, "/v1/decide", DECIDE_BODY)
        self.assertEqual(status, 503)
        gate.set()
        holder.join(5)
        self.assertEqual(engine.calls, 1)

    def test_a_malformed_request_is_refused_without_queueing(self):
        gate = threading.Event()
        engine = FakeEngine(gate=gate)
        base = self.start(engine)
        holder = self.hold_slot(base, engine)
        started = time.monotonic()
        self.assertEqual(self.request(base, "/v1/decide", {"state": "s"})[0], 422)
        self.assertLess(time.monotonic() - started, 1)
        gate.set()
        holder.join(5)

    def test_error_statuses(self):
        base = self.start(FakeEngine())
        self.assertEqual(self.request(base, "/v1/decide", raw=b"{nope")[0], 400)
        self.assertEqual(self.request(base, "/v1/decide", {"state": "s"})[0], 422)
        status, payload, _ = self.request(
            base,
            "/v1/decide",
            {"model": "other", "state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}},
        )
        self.assertEqual(status, 404)
        self.assertIn(MODEL, payload["error"]["message"])
        self.assertEqual(self.request(base, "/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
