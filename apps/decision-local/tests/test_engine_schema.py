"""The heads `decide.py` builds, compiled by the real GLiNER schema code.

Skipped where `gliner2` is not installed, which is CI's plain-Python test job.
The Dockerfile's test stage runs the whole suite against the pinned library on
every image build, so it runs there.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from decide import prepare  # noqa: E402

try:
    from gliner2.classification import compile_schema  # noqa: F401

    HAVE_GLINER = True
except ImportError:  # pragma: no cover - depends on the environment
    HAVE_GLINER = False


@unittest.skipUnless(HAVE_GLINER, "gliner2 is not installed")
class EngineSchemaTest(unittest.TestCase):
    def compile(self, questions):
        from engine import Engine
        from gliner2.classification import compile_schema

        engine = Engine.__new__(Engine)
        return compile_schema(engine._schema(prepare({"state": "s", "questions": questions}).heads))

    def test_rewritten_names_compile_without_collisions(self):
        compiled = self.compile(
            {
                "a(b)": {"type": "choice", "instructions": "x", "criteria": {"a(b)": None, "a b": None, "a b 2": None}},
                "a b": {"type": "noul", "instructions": "Two?"},
                "needs reply": {"type": "score", "instructions": "How?", "criteria": ["low", "high"]},
                "needs reply: now": {"type": "noul", "instructions": "Now?"},
            }
        )
        specs = {spec.name: spec for spec in compiled.task_specs}
        self.assertEqual(len(specs), 4)
        self.assertEqual(len(specs["a_b"].label_names), 3)


if __name__ == "__main__":
    unittest.main()
