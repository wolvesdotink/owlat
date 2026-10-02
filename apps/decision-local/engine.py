"""The GLiNER2 half: load one Decide checkpoint and score heads with it.

Everything model-shaped lives here and nothing else does. `decide.py` turns a
request into heads and answers; this file turns heads into a
`gliner2.classification.ClassificationSchema`, runs it, and hands back one
probability map per head.

All heads of a request are scored in ONE pass over the text, the way the
model card runs its "several decisions at once" example. Long text is split
into overlapping word windows and the per-label logits are aggregated by
maximum before the softmax (`Classifier.classify_long`), so a sentence that
settles a question near the end of a long message still counts.
"""

from __future__ import annotations

import logging
import os
from typing import Mapping, Sequence

from decide import Head

log = logging.getLogger("decision-local")

# The model we ship by default and the exact revision it was measured at.
# A floating `main` would let an upstream re-upload change every answer under
# a running deployment, so the default is pinned like every other image here.
DEFAULT_MODEL = "fastino/GLiNER2.5-multi-Decide"
DEFAULT_REVISION = "a35a0cd3b7a0f00f2effc576f454cd48fa98aa5f"


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        log.warning("%s=%r is not an integer; using %d", name, raw, default)
        return default
    return value if value > 0 else default


class Engine:
    """One loaded checkpoint. Not thread-safe; the server serialises calls."""

    def __init__(self) -> None:
        self.model_id = os.environ.get("DECISION_LOCAL_MODEL", "").strip() or DEFAULT_MODEL
        revision = os.environ.get("DECISION_LOCAL_MODEL_REVISION", "").strip()
        # The pinned revision belongs to the default model only. Another model
        # gets the revision its operator names, or the hub's current one.
        self.revision = revision or (DEFAULT_REVISION if self.model_id == DEFAULT_MODEL else None)
        self.chunk_size = _int_env("DECISION_LOCAL_CHUNK_WORDS", 384)
        self.chunk_overlap = min(_int_env("DECISION_LOCAL_CHUNK_OVERLAP", 64), self.chunk_size - 1)
        self._classifier = None
        self._config = None

    def load(self) -> None:
        # Imported here so `decide.py` and the tests never need torch.
        import torch
        from gliner2.classification import ClassificationConfig, Classifier

        threads = _int_env("DECISION_LOCAL_THREADS", 0)
        if threads:
            torch.set_num_threads(threads)
        kwargs = {"revision": self.revision} if self.revision else {}
        log.info("loading %s%s", self.model_id, f"@{self.revision}" if self.revision else "")
        classifier = Classifier.from_pretrained(self.model_id, **kwargs)
        classifier.eval()
        self._classifier = classifier
        # Confidence is computed by `decide.py` over the full distribution;
        # the library's own (top-label probability) is not needed.
        self._config = ClassificationConfig(include_confidence=False)
        log.info("loaded %s", self.model_id)

    @property
    def ready(self) -> bool:
        return self._classifier is not None

    def _schema(self, heads: Sequence[Head]):
        from gliner2.classification import ClassificationSchema

        schema = ClassificationSchema()
        for head in heads:
            labels = {label.name: label.description for label in head.labels}
            if head.kind == "score":
                schema.ordinal(head.name, labels, instruction=head.instruction)
            else:
                schema.single(head.name, labels, instruction=head.instruction)
        return schema

    def _count_tokens(self, text: str) -> int:
        processor = getattr(getattr(self._classifier, "model", None), "processor", None)
        tokenizer = getattr(processor, "tokenizer", None)
        if tokenizer is not None:
            try:
                return len(tokenizer.tokenize(text))
            except Exception:  # noqa: BLE001 - usage is reporting, never a failure
                pass
        return len(text.split())

    def score(
        self, text: str, heads: Sequence[Head]
    ) -> tuple[Mapping[str, Mapping[str, float]], int]:
        if self._classifier is None:
            raise RuntimeError("The model is not loaded yet.")
        result = self._classifier.classify_long(
            text,
            self._schema(heads),
            config=self._config,
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            aggregate="max",
        )
        scores = {head.name: dict(result.probabilities(head.name)) for head in heads}
        return scores, self._count_tokens(text)
