import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from decide import (  # noqa: E402
    DecisionRequestError,
    ModelNotServedError,
    clean,
    decide,
    peakedness,
    prepare,
    render_state,
)

MODEL = "fastino/GLiNER2.5-multi-Decide"


def scorer_from(table, tokens=7):
    """A fake engine: fixed probabilities per head name, recording what it saw."""
    seen = {}

    def score(text, heads):
        seen["text"] = text
        seen["heads"] = heads
        return {head.name: table[head.name] for head in heads}, tokens

    return score, seen


class PrepareTest(unittest.TestCase):
    def test_maps_each_question_type_onto_a_head(self):
        prepared = prepare(
            {
                "state": "hello",
                "questions": {
                    "rain": {
                        "type": "noul",
                        "instructions": "Does it rain?",
                        "criteria": {"true": "It rains.", "false": "Anything else."},
                    },
                    "topic": {
                        "type": "choice",
                        "instructions": "Which topic?",
                        "criteria": {"billing": "Money", "other": None},
                    },
                    "urgency": {
                        "type": "score",
                        "instructions": "How urgent?",
                        "criteria": ["Can wait", "Today", "Now"],
                    },
                },
            }
        )
        rain, topic, urgency = prepared.heads
        self.assertEqual(rain.kind, "noul")
        self.assertEqual([(l.name, l.description, l.key) for l in rain.labels], [
            ("yes", "It rains.", "yes"),
            ("no", "Anything else.", "no"),
        ])
        self.assertEqual([(l.name, l.description) for l in topic.labels], [
            ("billing", "Money"),
            ("other", None),
        ])
        self.assertEqual([(l.name, l.key) for l in urgency.labels], [
            ("Can wait", "0"),
            ("Today", "1"),
            ("Now", "2"),
        ])
        self.assertEqual(urgency.instruction, "How urgent?")

    def test_rewrites_reserved_tokens_and_keeps_names_distinct(self):
        prepared = prepare(
            {
                "state": "x",
                "questions": {
                    "q": {
                        "type": "choice",
                        "instructions": "Pick one (carefully) [L]",
                        "criteria": {"a(b)": "uses (parens)", "a b": None},
                    }
                },
            }
        )
        head = prepared.heads[0]
        self.assertEqual(head.instruction, "Pick one carefully")
        self.assertEqual([l.name for l in head.labels], ["a b", "a b 2"])
        self.assertEqual([l.key for l in head.labels], ["a(b)", "a b"])
        self.assertEqual(head.labels[0].description, "uses parens")

    def test_keeps_rewritten_labels_distinct_from_labels_that_already_look_rewritten(self):
        prepared = prepare(
            {
                "state": "x",
                "questions": {
                    "q": {
                        "type": "choice",
                        "instructions": "Pick one",
                        "criteria": {"a(b)": None, "a b": None, "a b 2": None},
                    }
                },
            }
        )
        labels = prepared.heads[0].labels
        names = [label.name for label in labels]
        self.assertEqual(len(set(names)), 3)
        self.assertEqual([label.key for label in labels], ["a(b)", "a b", "a b 2"])
        # A key that was already clean keeps its own name.
        self.assertEqual(labels[2].name, "a b 2")

    def test_gives_heads_names_no_other_head_can_shadow(self):
        prepared = prepare(
            {
                "state": "x",
                "questions": {
                    "a(b)": {"type": "noul", "instructions": "One?"},
                    "a b": {"type": "noul", "instructions": "Two?"},
                    "a b 2": {"type": "noul", "instructions": "Three?"},
                    "needs reply": {"type": "noul", "instructions": "Four?"},
                    "needs reply: now": {"type": "noul", "instructions": "Five?"},
                },
            }
        )
        names = [head.name for head in prepared.heads]
        self.assertEqual(len(set(names)), len(names))
        self.assertEqual([head.question_id for head in prepared.heads][0], "a(b)")
        # GLiNER's rule: no head may be another followed by a space or a colon.
        for x in names:
            self.assertNotRegex(x, r"[ :]")
            for y in names:
                if x != y and y.startswith(x):
                    self.assertNotIn(y[len(x)], (" ", ":"), (x, y))

    def test_refuses_malformed_requests(self):
        bad = [
            None,
            {"questions": {"q": {"type": "noul", "instructions": "x"}}},
            {"state": 3, "questions": {"q": {"type": "noul", "instructions": "x"}}},
            {"state": "s", "questions": {}},
            {"state": "s", "questions": {"q": {"type": "noul", "instructions": "  "}}},
            {"state": "s", "questions": {"q": {"type": "maybe", "instructions": "x"}}},
            {"state": "s", "questions": {"q": {"type": "choice", "instructions": "x", "criteria": {}}}},
            {"state": "s", "questions": {"q": {"type": "score", "instructions": "x", "criteria": ["one"]}}},
            {"state": "s", "questions": {"q": {"type": "noul", "instructions": "()"}}},
            {"state": "s", "model": "", "questions": {"q": {"type": "noul", "instructions": "x"}}},
        ]
        for body in bad:
            with self.subTest(body=body):
                with self.assertRaises(DecisionRequestError):
                    prepare(body)


class DecideCollisionTest(unittest.TestCase):
    def test_options_that_clean_alike_keep_their_own_probabilities(self):
        body = {
            "state": "s",
            "questions": {
                "q": {
                    "type": "choice",
                    "instructions": "x",
                    "criteria": {"a(b)": None, "a b": None, "a b 2": None},
                }
            },
        }

        def score(text, heads):
            head = heads[0]
            # A distinct probability per model-facing name; a merged name would
            # hand two caller keys the same number.
            return {head.name: {label.name: [0.5, 0.3, 0.2][i] for i, label in enumerate(head.labels)}}, 1

        answer = decide(body, score, MODEL)["answers"]["q"]
        self.assertEqual(answer["probabilities"], {"a(b)": 0.5, "a b": 0.3, "a b 2": 0.2})
        self.assertEqual(answer["choice"], "a(b)")


class RenderStateTest(unittest.TestCase):
    def test_passes_strings_through(self):
        self.assertEqual(render_state("Hi there"), "Hi there")

    def test_renders_objects_as_lines_in_caller_order(self):
        rendered = render_state(
            {"subject": "Invoice", "flags": ["urgent", True], "sender": {"name": "Ada", "vip": None}}
        )
        self.assertEqual(
            rendered,
            "subject: Invoice\nflags:\n  - urgent\n  - true\nsender:\n  name: Ada\n  vip: null",
        )


class DecideTest(unittest.TestCase):
    def body(self):
        return {
            "model": MODEL,
            "state": "It is raining in Hamburg.",
            "questions": {
                "rain": {"type": "noul", "instructions": "Does it rain?"},
                "topic": {
                    "type": "choice",
                    "instructions": "Topic?",
                    "criteria": {"weather": None, "sports": None},
                },
                "urgency": {
                    "type": "score",
                    "instructions": "How urgent?",
                    "criteria": ["low", "mid", "high"],
                },
            },
        }

    def test_answers_on_the_hosted_wire(self):
        score, seen = scorer_from(
            {
                "rain": {"yes": 0.9, "no": 0.1},
                "topic": {"weather": 0.75, "sports": 0.25},
                "urgency": {"low": 0.2, "mid": 0.5, "high": 0.3},
            }
        )
        result = decide(self.body(), score, MODEL)
        self.assertEqual(seen["text"], "It is raining in Hamburg.")
        self.assertEqual(result["model"], MODEL)
        self.assertEqual(result["usage"], {"input_tokens": 7, "output_tokens": 0})
        answers = result["answers"]
        self.assertEqual(answers["rain"], {"type": "noul", "noul": 0.9})
        self.assertEqual(answers["topic"]["choice"], "weather")
        self.assertEqual(answers["topic"]["probabilities"], {"weather": 0.75, "sports": 0.25})
        urgency = answers["urgency"]
        self.assertEqual(urgency["legend"], {"0": "low", "1": "mid", "2": "high"})
        self.assertEqual(urgency["probabilities"], {"0": 0.2, "1": 0.5, "2": 0.3})
        self.assertAlmostEqual(urgency["score"], 1.1)
        for answer in (answers["topic"], urgency):
            self.assertGreaterEqual(answer["confidence"], 0)
            self.assertLessEqual(answer["confidence"], 1)

    def test_renormalises_and_maps_rewritten_labels_back(self):
        body = {
            "state": "s",
            "questions": {
                "q": {"type": "choice", "instructions": "x", "criteria": {"a(b)": None, "c": None}}
            },
        }
        score, _ = scorer_from({"q": {"a b": 0.3, "c": 0.3}})
        answer = decide(body, score, MODEL)["answers"]["q"]
        # A tie goes to the option the caller listed first, under its own key.
        self.assertEqual(answer["choice"], "a(b)")
        self.assertEqual(answer["probabilities"], {"a(b)": 0.5, "c": 0.5})
        self.assertEqual(answer["confidence"], 0.0)

    def test_refuses_a_model_it_does_not_serve(self):
        body = self.body()
        body["model"] = "fastino/GLiNER2.5-Decide"
        score, _ = scorer_from({})
        with self.assertRaises(ModelNotServedError) as caught:
            decide(body, score, MODEL)
        self.assertIn("DECISION_LOCAL_MODEL", str(caught.exception))

    def test_an_absent_model_means_whatever_is_loaded(self):
        body = self.body()
        del body["model"]
        score, _ = scorer_from(
            {
                "rain": {"yes": 0.5, "no": 0.5},
                "topic": {"weather": 0.5, "sports": 0.5},
                "urgency": {"low": 1, "mid": 0, "high": 0},
            }
        )
        self.assertEqual(decide(body, score, MODEL)["model"], MODEL)

    def test_an_incomplete_engine_answer_is_an_error_not_a_guess(self):
        score, _ = scorer_from({"rain": {"yes": 1.0}, "topic": {}, "urgency": {}})
        with self.assertRaises(RuntimeError):
            decide(self.body(), score, MODEL)


class HelpersTest(unittest.TestCase):
    def test_peakedness(self):
        self.assertEqual(peakedness([0.5, 0.5]), 0.0)
        self.assertEqual(peakedness([1.0, 0.0, 0.0]), 1.0)
        self.assertEqual(peakedness([1.0]), 1.0)
        middle = peakedness([0.8, 0.2])
        self.assertTrue(0 < middle < 1)
        self.assertFalse(math.isnan(middle))

    def test_clean(self):
        self.assertEqual(clean("  a (b)  [DESCRIPTION] c "), "a b c")


if __name__ == "__main__":
    unittest.main()
