"""The decision wire, answered by a local classifier.

This module is the whole contract between Owlat's decision plane and the
local engine, and it imports nothing that needs a model: the engine
(`engine.py`) hands it one probability map per question and this file does
everything else. That split is what lets the tests run on a bare Python with
no torch installed.

THE WIRE is the one `apps/api/convex/lib/decisionProviders/wire.ts` already
speaks to the hosted provider, on purpose. The Convex adapter for this engine
reuses that codec unchanged, so its strict decoding (no missing key, no extra
key, a distribution over exactly the options that were sent, summing to one)
holds here too, and the two adapters cannot drift into two dialects.

    request   {"model"?, "state", "questions": {id: {"type", "instructions",
               "criteria"?}}}
    response  {"model", "answers": {id: answer}, "usage": {"input_tokens",
               "output_tokens"}}

where an answer is one of

    {"type": "noul", "noul": p}
    {"type": "choice", "choice": label, "probabilities": {...}, "confidence": c}
    {"type": "score", "score": x, "legend": {"0": level, ...},
     "probabilities": {"0": p, ...}, "confidence": c}

HOW EACH QUESTION BECOMES A CLASSIFICATION HEAD:

  * noul   -> a single-label head over "yes" and "no", the criteria becoming
              the two label descriptions. The answer is P(yes).
  * choice -> a single-label head over the option keys, each described by its
              criteria text when there is one.
  * score  -> an ordinal head over the levels, lowest first. The score is the
              expected level index (0-based on the wire, as the hosted
              provider sends it), so it can land between two levels.

The instructions become the head's prompt. Probabilities are the softmax over
the head's own labels. `confidence` is how peaked that distribution is: one
minus its normalised entropy, so a uniform distribution reads 0 and a certain
one reads 1. None of this is calibrated, and the Convex adapter says so.

GLiNER refuses some strings outright: label names, descriptions and prompts
are injected into the model input verbatim, so its marker tokens and
parentheses are reserved. They are rewritten here, and the model-facing name
of every label is mapped back to the key Owlat sent, so a caller never sees
the rewrite.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

# Marker tokens GLiNER injects into its input. A string containing one would
# corrupt the alignment between logits and labels, so the library refuses it.
_RESERVED_TOKENS = ("[P]", "[L]", "[C]", "[E]", "[R]", "[DESCRIPTION]", "[EXAMPLE]", "[OUTPUT]")
_RESERVED_CHARS = ("(", ")")

MAX_QUESTIONS = 64
MAX_CHOICE_OPTIONS = 255
MIN_SCORE_LEVELS = 2

NOUL_TRUE = "yes"
NOUL_FALSE = "no"


class DecisionRequestError(ValueError):
    """The request is malformed. Maps to HTTP 422; retrying cannot help."""


@dataclass(frozen=True)
class Label:
    """One label as the model sees it, and the key the caller sent for it."""

    name: str
    description: str | None
    key: str


@dataclass(frozen=True)
class Head:
    """One classification head: what the engine scores for one question."""

    question_id: str
    name: str
    kind: str  # noul | choice | score
    instruction: str
    labels: tuple[Label, ...]


@dataclass
class Prepared:
    """A request reduced to the text and heads the engine needs."""

    model: str | None
    text: str
    heads: list[Head] = field(default_factory=list)


def clean(text: str) -> str:
    """Rewrite a string so GLiNER accepts it, keeping its meaning.

    Parentheses are dropped rather than swapped for brackets, which could
    assemble a marker token. Whitespace is collapsed because the rewrite can
    leave doubled spaces.
    """
    out = text
    for token in _RESERVED_TOKENS:
        out = out.replace(token, " ")
    for char in _RESERVED_CHARS:
        out = out.replace(char, " ")
    return re.sub(r"\s+", " ", out).strip()


def _unique(names: Sequence[str], separator: str = " ") -> list[str]:
    """Keep cleaned names distinct: two keys that clean alike must not merge.

    A name that is already unique keeps itself, and so does the first of a
    repeated one. Every later repeat gets the lowest free numeric suffix, checked
    against every name in the list as well as every name already handed out, so
    `a(b)`, `a b` and `a b 2` become `a b`, `a b 3` and `a b 2` rather than two
    `a b 2`s that a dict would then merge into one option.
    """
    taken = set(names)
    emitted: set[str] = set()
    result = []
    for name in names:
        candidate = name
        if name in emitted:
            n = 2
            while f"{name}{separator}{n}" in taken or f"{name}{separator}{n}" in emitted:
                n += 1
            candidate = f"{name}{separator}{n}"
        emitted.add(candidate)
        result.append(candidate)
    return result


def task_name(question_id: str) -> str:
    """The model-facing head name for a question id.

    GLiNER reads a head back out of its prompt by boundary-aware longest
    match, so it refuses two heads where one is the other followed by a space
    or a colon (`a b` beside `a b 2`). Heads therefore never contain either:
    spaces and colons become underscores, the snake_case the model card's own
    head names use, and with neither character present no name can be a
    boundary prefix of another.
    """
    name = re.sub(r"[\s:]+", "_", clean(question_id)).strip("_")
    if not name:
        raise DecisionRequestError("A question id has no usable text once reserved tokens are removed.")
    return name


def render_state(state: Any) -> str:
    """Render the state as text for an encoder.

    A string is passed through. Objects and arrays become indented
    `key: value` and `- item` lines in the caller's own order: a classifier
    reads prose far better than JSON punctuation, and the order is the
    caller's so the same state always renders the same way.
    """
    if isinstance(state, str):
        return state
    lines: list[str] = []
    _render_value(state, 0, lines, None)
    return "\n".join(lines)


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _render_value(value: Any, depth: int, lines: list[str], label: str | None) -> None:
    indent = "  " * depth
    if isinstance(value, Mapping):
        if label is not None:
            lines.append(f"{indent}{label}:")
            depth += 1
        for key, item in value.items():
            if isinstance(item, (Mapping, list)):
                _render_value(item, depth, lines, str(key))
            else:
                lines.append(f"{'  ' * depth}{key}: {_scalar(item)}")
        return
    if isinstance(value, list):
        if label is not None:
            lines.append(f"{indent}{label}:")
            depth += 1
        for item in value:
            if isinstance(item, (Mapping, list)):
                lines.append(f"{'  ' * depth}-")
                _render_value(item, depth + 1, lines, None)
            else:
                lines.append(f"{'  ' * depth}- {_scalar(item)}")
        return
    lines.append(f"{indent}{label}: {_scalar(value)}" if label else f"{indent}{_scalar(value)}")


def _require_text(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DecisionRequestError(f"{what} must be a non-empty string.")
    cleaned = clean(value)
    if not cleaned:
        raise DecisionRequestError(f"{what} has no usable text once reserved tokens are removed.")
    return cleaned


def _labels(keys: Sequence[str], descriptions: Sequence[str | None], what: str) -> tuple[Label, ...]:
    names = _unique([_require_text(key, f"{what} label") for key in keys])
    return tuple(
        Label(name=name, description=clean(desc) or None if desc else None, key=key)
        for name, desc, key in zip(names, descriptions, keys)
    )


def _head(question_id: str, name: str, raw: Any) -> Head:
    if not isinstance(raw, Mapping):
        raise DecisionRequestError(f"Question '{question_id}' is not an object.")
    kind = raw.get("type")
    instruction = _require_text(raw.get("instructions"), f"Question '{question_id}' instructions")
    criteria = raw.get("criteria")

    if kind == "noul":
        descriptions: list[str | None] = [None, None]
        if criteria is not None:
            if not isinstance(criteria, Mapping):
                raise DecisionRequestError(f"Question '{question_id}' criteria must be an object.")
            descriptions = [
                _require_text(criteria.get("true"), f"Question '{question_id}' true criterion"),
                _require_text(criteria.get("false"), f"Question '{question_id}' false criterion"),
            ]
        labels = _labels([NOUL_TRUE, NOUL_FALSE], descriptions, f"Question '{question_id}'")
        return Head(question_id, name, "noul", instruction, labels)

    if kind == "choice":
        if not isinstance(criteria, Mapping) or not criteria:
            raise DecisionRequestError(f"Question '{question_id}' needs at least one option.")
        if len(criteria) > MAX_CHOICE_OPTIONS:
            raise DecisionRequestError(
                f"Question '{question_id}' has {len(criteria)} options; the cap is {MAX_CHOICE_OPTIONS}."
            )
        keys = list(criteria.keys())
        descs = []
        for key in keys:
            desc = criteria[key]
            if desc is not None and not isinstance(desc, str):
                raise DecisionRequestError(
                    f"Question '{question_id}' option descriptions must be strings or null."
                )
            descs.append(desc if desc and desc.strip() else None)
        return Head(question_id, name, "choice", instruction, _labels(keys, descs, f"Question '{question_id}'"))

    if kind == "score":
        if not isinstance(criteria, list) or len(criteria) < MIN_SCORE_LEVELS:
            raise DecisionRequestError(
                f"Question '{question_id}' needs at least {MIN_SCORE_LEVELS} ordered levels."
            )
        # The level text IS the label the model reads; the wire key is the
        # 0-based ordinal, which is what the legend and probabilities use.
        levels = [_require_text(level, f"Question '{question_id}' level") for level in criteria]
        names = _unique(levels)
        labels = tuple(
            Label(name=level_name, description=None, key=str(index))
            for index, level_name in enumerate(names)
        )
        return Head(question_id, name, "score", instruction, labels)

    raise DecisionRequestError(f"Question '{question_id}' has unknown type {kind!r}.")


def prepare(body: Any) -> Prepared:
    """Validate a request body and reduce it to text plus classification heads."""
    if not isinstance(body, Mapping):
        raise DecisionRequestError("The request body must be a JSON object.")
    model = body.get("model")
    if model is not None and (not isinstance(model, str) or not model.strip()):
        raise DecisionRequestError("model must be a non-empty string when present.")
    if "state" not in body:
        raise DecisionRequestError("state is required.")
    state = body["state"]
    if not isinstance(state, (str, list, Mapping)):
        raise DecisionRequestError("state must be a string, an array or an object.")
    questions = body.get("questions")
    if not isinstance(questions, Mapping) or not questions:
        raise DecisionRequestError("questions must be a non-empty object.")
    if len(questions) > MAX_QUESTIONS:
        raise DecisionRequestError(f"At most {MAX_QUESTIONS} questions per request.")

    ids = list(questions.keys())
    for qid in ids:
        _require_text(qid, "Question id")
    names = _unique([task_name(qid) for qid in ids], separator="_")
    heads = [_head(qid, name, questions[qid]) for qid, name in zip(ids, names)]
    text = render_state(state)
    if not text.strip():
        # An empty state is still a question the caller asked; the model
        # needs at least one token to encode.
        text = "-"
    return Prepared(model=model.strip() if isinstance(model, str) else None, text=text, heads=heads)


# Engine signature: given the text and the heads, return one probability map
# per head NAME, keyed by label NAME, plus the encoder token count.
Scorer = Callable[[str, Sequence[Head]], tuple[Mapping[str, Mapping[str, float]], int]]


def _normalise(head: Head, raw: Mapping[str, float]) -> dict[str, float]:
    """Probabilities keyed by the caller's keys, as a valid distribution."""
    probs = {}
    for label in head.labels:
        value = raw.get(label.name)
        if value is None or not math.isfinite(value) or value < 0:
            raise RuntimeError(f"The engine returned no probability for '{label.name}'.")
        probs[label.key] = float(value)
    total = sum(probs.values())
    if total <= 0:
        raise RuntimeError(f"The engine returned an empty distribution for '{head.question_id}'.")
    return {key: value / total for key, value in probs.items()}


def peakedness(probabilities: Sequence[float]) -> float:
    """One minus normalised entropy: 0 for uniform, 1 for a single certain option."""
    n = len(probabilities)
    if n <= 1:
        return 1.0
    entropy = -sum(p * math.log(p) for p in probabilities if p > 0)
    return max(0.0, min(1.0, 1.0 - entropy / math.log(n)))


def _answer(head: Head, probs: dict[str, float]) -> dict[str, Any]:
    if head.kind == "noul":
        return {"type": "noul", "noul": probs[NOUL_TRUE]}
    confidence = peakedness(list(probs.values()))
    if head.kind == "choice":
        # Highest probability wins; ties go to the option the caller listed first.
        best = max(head.labels, key=lambda label: probs[label.key]).key
        return {"type": "choice", "choice": best, "probabilities": probs, "confidence": confidence}
    expected = sum(int(key) * p for key, p in probs.items())
    top = len(head.labels) - 1
    return {
        "type": "score",
        "score": max(0.0, min(float(top), expected)),
        "legend": {label.key: label.name for label in head.labels},
        "probabilities": probs,
        "confidence": confidence,
    }


def decide(body: Any, scorer: Scorer, model_id: str) -> dict[str, Any]:
    """Answer one request body. Raises DecisionRequestError for a bad request."""
    prepared = prepare(body)
    if prepared.model is not None and prepared.model != model_id:
        raise ModelNotServedError(prepared.model, model_id)
    raw, input_tokens = scorer(prepared.text, prepared.heads)
    answers = {}
    for head in prepared.heads:
        if head.name not in raw:
            raise RuntimeError(f"The engine returned no scores for '{head.question_id}'.")
        answers[head.question_id] = _answer(head, _normalise(head, raw[head.name]))
    return {
        "model": model_id,
        "answers": answers,
        "usage": {"input_tokens": int(input_tokens), "output_tokens": 0},
    }


class ModelNotServedError(LookupError):
    """The request named a model this engine did not load. Maps to HTTP 404."""

    def __init__(self, requested: str, served: str):
        super().__init__(
            f"This engine serves '{served}', not '{requested}'. Pick '{served}' as the decision "
            "model, or set DECISION_LOCAL_MODEL on the decision-local service and restart it."
        )
        self.requested = requested
        self.served = served
