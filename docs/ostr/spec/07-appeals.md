# 07. Appeals

[Index](../spec-v0.md) · prev: [06. Scoring](06-scoring.md) · next:
[08. Query and distribution](08-query.md)

Appeals are public, structured and time-bound. Every step is an attestation, so
the outcome of a dispute is as visible as the accusation that started it. A
private appeals process would recreate the delisting rituals this registry
exists to replace.

## 7.1 The protocol

1. **File.** The subject publishes an `appeal` naming the contested entries by
   `LogEntryRef`. The filer MUST prove control of the appealed domain by signing
   with the key at `_ostr.<domain>`. That is not a hurdle: the accused party is
   definitionally reachable through its own DNS.
2. **Answer.** The named observer has T, illustratively 14 days, with the
   operative value in `POLICY_V1`, to either substantiate through challenge
   sampling ([04 §4.4](04-evidence-and-reporting.md)) or file a `retraction`.
3. **Substantiated.** The observer publishes a `response` with
   `outcome: 'substantiated'`, adjudicated by monitors against opened samples.
   The contested attestations keep counting. The subject receives the verdict
   and aggregate statistics, never bundles.
4. **Retracted.** The observer publishes a `response` with
   `outcome: 'retracted'` plus a `retraction` per contested entry. The
   attestations stop counting from the retraction's log position; they stay
   visible.
5. **No answer.** After T with no `response`, the scoring policy MUST
   automatically exclude the contested attestations, and the observer takes a
   responsiveness penalty, subject to the first-lapse grace in §7.2.

All five outcomes, including silence, are on the log. There is no path where a
score moves and no record explains why.

An appeal MUST NOT pause scoring while it runs. A pending appeal that suspended
the evidence would make filing one a free way to buy a fortnight of clean
standing.

## 7.2 The three anti-weaponization guards

An appeal right that is free, unbounded and unlimited is a denial-of-service
tool pointed at volunteer observers. Three guards, all mandatory:

**1. The retention window bounds the filing window.** An appeal MUST be filed
within the evidence retention window, illustratively 60 days from the contested
attestation's inclusion. Two reasons, and both matter. Older evidence has
already decayed in weight, so the practical stakes are small. And observers
cannot be obliged to substantiate what they no longer hold: retention is capped
by the privacy floor ([09-privacy](09-privacy.md)), so an unbounded appeal
window would force observers to choose between keeping user data forever and
losing every late appeal by default. A late appeal MUST be rejected as
out of window, on the record, rather than silently ignored.

**2. Rate limits, and a cost for appeals that fail.** Appeals are rate-limited
per subject. A pattern of appeals that fail on sampling costs the subject
standing, which is what closes the appeal-flooding path in
[10-threat-model](10-threat-model.md): a flagged sender cannot bury a small
observer in challenge work for free. Cost is proportional to the sample, never
to the batch, so the work an observer owes per appeal is bounded by the
published sample size, whatever the size of the batch under dispute. Both the
per-subject rate limit and the sample size are deployment values rather than
`POLICY_V1` constants at v1, and both MUST be published
([06 §6.6](06-scoring.md)).

**3. First-lapse grace for small observers.** A small observer's first
unanswered challenge in a rolling year costs only the contested attestations,
not standing. Volunteer operators go on holiday. The penalty exists to deter
fabrication, not participation, and a penalty that fires on the first missed
deadline would quietly select for large operators. The size threshold and the
rolling window are deployment values at v1, published with the policy version
rather than carried inside it ([06 §6.6](06-scoring.md)).

## 7.3 What appeals are not

- Not a route to evidence. The subject never receives bundles, in any outcome
  ([04 §4.4](04-evidence-and-reporting.md)).
- Not a deletion mechanism. A successful appeal produces a retraction, and the
  original attestation stays in the log. The only content-withholding path in
  this system is the redaction event
  ([11-governance](11-governance.md)), and it is not reachable from here.
- Not a negotiation. There is no party to negotiate with, no discretion to
  exercise, and no fee anywhere. Substantiation is a check monitors run
  mechanically; the score is arithmetic over what survives.
- Not the only correction path. An observer that notices its own error SHOULD
  file a `retraction` without waiting to be appealed, and doing so avoids the
  responsiveness penalty entirely.
