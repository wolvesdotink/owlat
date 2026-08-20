# 06. Scoring

[Index](../spec-v0.md) · prev: [05. Transparency logs](05-logs.md) · next:
[07. Appeals](07-appeals.md)

This section defines the **signal model**: what evidence exists, which way it
moves a score, and which bounds hold. It carries no tunables. Every weight,
half-life, cap, threshold and floor for `ostr-policy-v1` is declared once, as the
`POLICY_V1` constants exported from `@owlat/ostr-core/scoring`, and those
constants are normative. Numbers below are illustrations. Where prose here and
`POLICY_V1` disagree, `POLICY_V1` wins and this text is the bug.

## 6.1 Output

Scoring is a pure function `(sequenced entries, subject, asOf) -> ScoreResult`:
a tier, a 0 to 100 score, a policy version identifier, and an explanation.
`asOf` is the evaluation instant, an RFC 3339 argument rather than a clock read,
and every decay, expiry and window check below is measured against it (§6.2).

| Tier           | Meaning                                                     | Typical consumer policy                                 |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| `unknown`      | No, or almost no, evidence                                  | Neutral. Normal filtering, rate-limit new volume        |
| `establishing` | Good hygiene, short or low-volume history, possibly vouched | Slightly favourable, graduated volume acceptance        |
| `trusted`      | Sustained clean history across diverse observers            | Favourable weighting, relaxed rate limits               |
| `warned`       | Recent negative evidence, not yet chronic                   | Greylist-grade caution. The sender can see exactly why  |
| `flagged`      | Strong, multi-observer negative evidence                    | Aggressive filtering or rejection, still a local choice |

The explanation is the part no incumbent offers. Each `ExplanationGroup` names
a signal, its signed contribution, a deterministic sentence, and the
`LogEntryRef`s it derives from. A sender looking at its own standing sees the
same explanation a receiver sees. That symmetry is the transparency promise made
concrete, and an implementation that serves senders a different explanation than
receivers is not conformant.

Tier labels MUST be defined mechanically in the published policy, in terms of
thresholds over public inputs. The aggregator publishes arithmetic, not
characterization ([11-governance](11-governance.md)).

## 6.2 Determinism

### Input: the deterministic merge

With several logs, "the log" needs defining. The scoring input is a merge of
entries from a declared **as-of set** of signed tree heads, one per trusted log,
totally ordered by `(logId, index)`:

1. Take every entry at or below the declared head of each log in the as-of set,
   and drop entries not yet visible at `asOf`: those whose `loggedAt` is after
   it, and those carrying a `window` that has not closed by it
   ([02 §2.4](02-attestations.md)).
2. Order entries by `logId`, then by `index` ascending. A log ID is printable
   ASCII ([01 §1.3](01-terminology.md)), which is what makes this ordering
   unambiguous: over printable ASCII, byte order and UTF-16 code-unit order
   agree, so an implementation comparing strings natively and one comparing
   bytes produce the same sequence. An entry whose `logId` is not printable
   ASCII MUST be refused admission rather than sorted by guesswork.
3. Drop repeated coordinates: one `(logId, index)` is one leaf, and a second
   entry claiming the same coordinate is evidence of equivocation
   ([05 §5.6](05-logs.md)), not a second fact.
4. Deduplicate cross-submitted copies on the canonical bytes of the signed
   attestation ([05 §5.5](05-logs.md)), keeping the earliest provable `loggedAt`
   and the union of the `LogEntryRef`s for the explanation. This step is what
   makes the cross-submission rule safe: without it, sending one attestation to
   N logs multiplies its weight by N.
5. Apply the policy over that sequence.

Two parties computing against the same as-of set and the same policy version
MUST get byte-identical output, explanation sentences included. An aggregator
MUST publish the as-of set with every answer it serves
([08-query](08-query.md)).

Consequences implementations keep getting wrong:

- Ordering MUST NOT depend on wall-clock time, map iteration order, floating
  point accumulation order, or locale.
- `loggedAt` orders decay and windows; author-supplied `window` values MUST NOT
  be trusted for ordering ([02 §2.4](02-attestations.md)).
- The policy is a pure function. No network access, no `Date.now()`, no
  randomness. The evaluation instant is an argument.

### Versioning and cadence (plan §6.2, D5)

- The policy is identified as `ostr-policy-vN` and MUST appear in
  `ScoreResult.policy` and in every query answer.
- A new version MUST be published with a diff against the previous one before it
  takes effect.
- Versions ship at most quarterly.
- Aggregators MUST serve both the old and new version for a 60-day overlap, so
  consumers can compare before switching.
- The policy source and its constants are open, so a score dispute is always a
  dispute about specific attestations, never about a hidden model.

### The emergency lane

One exception exists, and it is narrow. For a scoring bug under active
exploitation, a shortened overlap is permitted when all of the following hold:

1. the change is limited to the exploited behaviour,
2. a supermajority of log operators signs off,
3. the justification is published before or with the change, as a signed, dated
   notice from each consenting operator, served with the policy version it
   applies to. It is not an attestation: the kinds are a closed set at `v: 1`
   and none of them carries a policy notice ([02 §2.1](02-attestations.md)). A
   `policy-notice` kind is a candidate for the next envelope version
   ([11 §11.5](11-governance.md)),
4. the shortened overlap is stated in that justification.

Without the lane, a live exploit survives up to a quarter. Without the published
justification and the operator supermajority, the lane is a governance backdoor
that lets one party rewrite scoring overnight and call it an emergency. Both
failure modes are worse than the cost of the procedure.

## 6.3 Signals

| Signal group                                           | Direction         | Notes                                                                                                                                                             |
| ------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complaint rate, verified reports over volume           | strong negative   | Rate, never count. Ten reports on a million messages is not ten reports on two hundred. Only DKIM-admissible reports count ([04](04-evidence-and-reporting.md))   |
| Spam-trap hits                                         | strong negative   | Weighted by observer standing; single-observer trap evidence is capped; observers below the size floor cannot submit it at all                                    |
| Authentication consistency: DMARC pass rate, alignment | positive          | The hygiene floor. A domain that cannot authenticate cannot accrue positive history at all                                                                        |
| History length times volume, log-scaled                | positive          | Time is the hardest signal to fake. Sub-linear, so megasenders do not drown everyone                                                                              |
| Observer diversity                                     | multiplier        | Evidence from forty unrelated observers far outweighs the same counts from two. This is the direct answer to Sybil evidence rings                                 |
| Posture: DNSSEC, `p=reject`, MTA-STS, declared IPs     | positive, bounded | Self-authored only ([02 §2.3.6](02-attestations.md)). Cheap to obtain, so bounded. It can lift `unknown` to `establishing` and MUST NOT by itself reach `trusted` |
| Vouches                                                | positive, bounded | See §6.5                                                                                                                                                          |
| Bounce and invalid-recipient rate                      | negative          | Dictionary-attack and stale-list indicator                                                                                                                        |

Key rotation is not a signal, in either direction
([04 §4.6](04-evidence-and-reporting.md)).

**Time decay.** Negative evidence decays with a half-life, around 60 days as an
illustration, provided behaviour actually changed; chronic evidence keeps
refreshing itself and does not decay away. Redemption is possible and its terms
are public, which is the opposite of open-ended blocklisting.

## 6.4 Weighting the witnesses (plan §6.3)

Every attestation is weighted by its author's own standing, because observers
are subjects too. The recursion that implies is bounded to exactly two passes,
and the bound is normative rather than an optimization:

- **Depth 0.** Scoring the caller's subject. Each witness contributes at its
  standing weight, obtained from depth 1.
- **Depth 1.** Scoring each witness as a subject over the same entry set, to
  obtain that weight. Here every witness of the witness contributes at
  `POLICY_V1.observerStanding.baseWeight`, so no third pass is ever requested.

An observer's weight MUST be memoized per evaluation, so an observer that
authored forty attestations is scored once and the result cannot depend on
traversal order. `createObserverWeigher()` in
`packages/ostr-core/src/scoring/standing.ts` is the reference implementation.

Deepening it is not a refinement, it is the failure mode. Unbounded recursion
over the observer graph makes each weight depend on the shape of the whole
graph, which is precisely what lets a ring of mutually attesting Sybils
bootstrap standing out of nothing, and it has no fixed point an independent
implementation could be required to reach. Two passes are enough for "a witness
with bad standing counts for less" and shallow enough that every implementation
computes the same number.

Three bounds keep the weighting honest, and all three are mandatory:

1. **Per-observer cap.** No single witness, however good its standing, may move
   a subject's score by more than the cap in `POLICY_V1`.
2. **Diversity requirement.** The `flagged` tier MUST NOT be reached without
   negative evidence from at least three observers under disjoint control,
   judged by infrastructure and ASN heuristics plus monitor findings. Observers
   that collapse to one control group count as one.
3. **Skin in the game.** An observer whose reports are repeatedly contradicted
   by the wider evidence, or who is the subject of an upheld `audit-finding`,
   loses weight globally, on the public record.

Positive evidence is weighted by observer standing too. Otherwise an evidence
ring buys a subject a clean history for the price of some domains.

`posture` is the single exception, and only because it is not evidence from a
witness: it is scored solely when self-authored ([02 §2.3.6](02-attestations.md)),
so there is no third party whose standing could weight it, and weighting it by
the subject's own standing would be circular. It is bounded instead (§6.3), and
every field of it is checkable in DNS.

## 6.5 Cold start and vouching (plan §6.4)

The newcomer path has to work without a hyperscaler's blessing, or the design
recreates the problem it set out to solve.

- **Day 0.** Publish a `posture` attestation. The domain is `unknown` with a
  hygiene annotation, so consumers see "new but well configured" rather than
  nothing at all.
- **Vouching.** An established party, a hosting provider, an instance operator,
  a business partner, files a scoped, expiring `vouch` and stakes a bounded
  slice of its own standing. If the newcomer spams inside the vouch window, the
  voucher's standing takes the documented hit. This is RFC 5518 with
  consequences, and the consequences are the part RFC 5518 lacked.
- **Graduated history.** Clean low-volume traffic across a growing observer set
  moves a domain to `establishing` within weeks and to `trusted` on sustained
  evidence. Every step MUST be visible to the sender, with the exact evidence
  gaps that remain.

A vouch MUST name another party. A `vouch` whose `observer` equals its subject
is inadmissible and contributes nothing ([02 §2.3.7](02-attestations.md)):
vouching is somebody else putting their standing at risk, and a self-vouch puts
nothing at risk while collecting the same bounded lift.

Stake caps, which are what stop vouching from being a laundering service:

- A voucher's total at-risk stake across all outstanding vouches MUST be capped
  as a fraction of its own standing. A hosting provider cannot underwrite a
  thousand tenants with reputation it only has once. The fraction is a
  deployment value at v1; `ostr-policy-v1` bounds the lift a subject can receive
  (`POLICY_V1.vouch`) but does not yet carry the voucher-side cap (§6.6).
- When outstanding vouches would exceed the cap, further vouches MUST carry
  reduced weight rather than reduced stake. The subject gets less lift; the
  voucher does not get free exposure.
- A vouch MUST have an expiry and MUST stop counting after it
  ([02 §2.3.7](02-attestations.md)).
- `vouch-revoke` ends future stake accrual. It MUST NOT unwind a hit the voucher
  has already taken, or revocation would just be an exit hatch used the moment a
  tenant starts spamming.
- Vouch lift is bounded like posture: vouches MUST NOT by themselves produce a
  `trusted` tier. Only observed behaviour does that.

## 6.6 Constants `ostr-policy-v1` does not carry

The rule in the index is that a tunable is declared exactly once, in `POLICY_V1`
([spec-v0](../spec-v0.md)). That rule is only worth anything if this document
does not point at `POLICY_V1` for values it has never held. `ostr-policy-v1`
carries the scoring constants: tier boundaries, signal weights, the complaint
and bounce curves, the authentication floor, history saturation, the diversity
multiplier, posture and vouch lift caps, the negative half-life, the
per-observer cap, observer standing weights, the `flagged` diversity minimum,
and the two appeal timers.

The requirements below are normative, and their values are declared per
deployment and MUST be published where the deployment publishes its policy
version. Folding each into a policy version is the intended path, and doing so
is a version bump, not a spec edit.

| Value                                                    | Required by                                                       | Status at v1                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Trap-observer size floor                                 | [02 §2.3.4](02-attestations.md)                                   | Deployment policy                                     |
| RSA key strength floor                                   | [04 §4.1](04-evidence-and-reporting.md)                           | 2048 bits, stated in §4.1                             |
| Evidence-bundle retention window                         | [04 §4.2](04-evidence-and-reporting.md)                           | Deployment policy, ~90 days, bounds the appeal window |
| Challenge sample size                                    | [04 §4.4](04-evidence-and-reporting.md)                           | Deployment policy, bounded and published              |
| k-anonymity floors: distinct traffic, distinct reporters | [04 §4.5](04-evidence-and-reporting.md), [09 §9.2](09-privacy.md) | Observer policy, at or above any deployment floor     |
| Mailbox-count threshold for observer mode                | [04 §4.5](04-evidence-and-reporting.md), [09 §9.2](09-privacy.md) | Implementation and deployment policy                  |
| Window-to-inclusion clock-skew tolerance                 | [02 §2.4](02-attestations.md)                                     | Deployment policy                                     |
| Key-record DNSSEC weighting                              | [03 §3.3](03-canonicalization-and-keys.md)                        | Recorded, not scored at v1                            |
| Voucher stake-cap fraction                               | §6.5                                                              | Deployment policy                                     |
| Per-subject appeal rate limit                            | [07 §7.2](07-appeals.md)                                          | Deployment policy                                     |
| Small-observer threshold and first-lapse grace window    | [07 §7.2](07-appeals.md)                                          | Deployment policy                                     |

A deployment value is not a licence to differ quietly. Two aggregators scoring
the same as-of set still owe byte-identical output (§6.2), so anything on this
list either sits outside the scoring function, as an admissibility or publishing
duty, or has to be agreed between the parties that compare results.
