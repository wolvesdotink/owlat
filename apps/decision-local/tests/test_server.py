import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import EngineState, make_handler  # noqa: E402

MODEL = "fastino/GLiNER2.5-multi-Decide"


class FakeEngine:
    model_id = MODEL
    revision = "abc"

    def __init__(self, ready=True, fail=False):
        self.ready = ready
        self.fail = fail

    def load(self):
        if self.fail:
            raise OSError("no network")
        self.ready = True

    def score(self, text, heads):
        return {head.name: {label.name: 1.0 for label in head.labels} for head in heads}, 3


class ServerTest(unittest.TestCase):
    def start(self, engine):
        self.state = EngineState(engine)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.state))
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def request(self, url, body=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
        req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.loads(response.read()), response.headers
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read()), error.headers

    def test_health_and_models(self):
        base = self.start(FakeEngine())
        status, payload, _ = self.request(f"{base}/health")
        self.assertEqual((status, payload["model"]), (200, MODEL))
        status, payload, _ = self.request(f"{base}/v1/models")
        self.assertEqual(payload["data"][0]["id"], MODEL)

    def test_decides(self):
        base = self.start(FakeEngine())
        status, payload, _ = self.request(
            f"{base}/v1/decide",
            {"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["answers"]["q"], {"type": "noul", "noul": 0.5})
        self.assertEqual(payload["usage"], {"input_tokens": 3, "output_tokens": 0})

    def test_loading_is_retriable(self):
        base = self.start(FakeEngine(ready=False))
        status, _, headers = self.request(f"{base}/health")
        self.assertEqual(status, 503)
        status, payload, headers = self.request(
            f"{base}/v1/decide",
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
        status, payload, _ = self.request(f"{base}/health")
        self.assertEqual(status, 503)
        self.assertIn("no network", payload["error"]["message"])

    def test_error_statuses(self):
        base = self.start(FakeEngine())
        self.assertEqual(self.request(f"{base}/v1/decide", raw=b"{nope")[0], 400)
        self.assertEqual(self.request(f"{base}/v1/decide", {"state": "s"})[0], 422)
        status, payload, _ = self.request(
            f"{base}/v1/decide",
            {"model": "other", "state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}},
        )
        self.assertEqual(status, 404)
        self.assertIn(MODEL, payload["error"]["message"])
        self.assertEqual(self.request(f"{base}/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
