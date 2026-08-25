# OSTR specification, version 0

**Status:** draft. This is the Phase 0 exit deliverable of the design plan
`TRUST_REGISTRY_PLAN_2026-08-20.html` (referred to below as "the plan", cited by
section, for example plan §7.2). The plan is the rationale document; this is the
normative one. Where they disagree, this specification wins and the plan is
stale.

**Working title.** "OSTR" (Open Sender Trust Registry) is a working title. The
public name is deliberately still open (plan §14, item O1) and gets chosen at
launch.
Whatever it becomes, it MUST NOT contain "Owlat". Neutrality is the whole point
of the design, and a registry named after one of its operators cannot claim it.
Implementations MUST NOT assume the string `ostr` is stable in user-visible
naming; the protocol identifiers in this document (`_ostr` DNS label, `v=1` key
records, `ostr-policy-vN`) are frozen wire strings and do not change with the
public name.

## What OSTR is

A public, federated, cryptographically transparent registry of how a domain or
IP has behaved as an email sender. Observers publish signed factual claims about
mail they actually received. Anyone can re-derive a sender's standing from those
claims with an open, deterministic scoring policy. No operator holds a private
input, and no operator can quietly change a score.

OSTR is a signal, not a verdict. The registry never instructs a receiver to
block anything; it publishes evidence, arithmetic, and an explanation, and the
delivery decision stays local (plan §1.3).

## Conformance

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL in this specification are to be interpreted as
described in RFC 2119 and RFC 8174, and only when they appear in all capitals.

Five conformance classes are defined, one per role in
[01-terminology](spec/01-terminology.md): log, observer, subject, aggregator,
monitor. A requirement labelled with a role binds implementations of that role
only. An implementation MAY fill several roles at once; it then satisfies every
matching requirement, including the separation duties in
[11-governance](spec/11-governance.md).

## Normative constants live in code, not here

This document defines the signal model: which evidence exists, what direction it
moves a score, what bounds hold, and what must be reproducible. It deliberately
does not carry the numbers.

Every tunable of the scoring function (weights, half-lives, caps, tier
thresholds, the diversity multiplier, observer standing weights, the appeal
timers) is declared exactly once, as the `POLICY_V1` constants exported from
`@owlat/ostr-core/scoring` in this repository. Those constants are the normative
values for `ostr-policy-v1`. This specification MUST NOT be read as fixing any of
them, and a second implementation MUST take them from `POLICY_V1` rather than
from prose here. Where a number appears in this document it is an illustration,
marked as such, and a conflict with `POLICY_V1` is resolved in favour of
`POLICY_V1`.

A handful of bounds sit outside the scoring function, in admissibility and
publishing duties: retention windows, k-anonymity floors, sample sizes, stake
fractions, size thresholds. `ostr-policy-v1` does not carry those, so this
document does not pretend it does; they are listed once, with their status, in
[06 §6.6](spec/06-scoring.md).

The reason is boring and important: the plan's determinism goal (two independent
implementations producing byte-identical explanations on a shared corpus) dies
the moment a constant exists in two places and drifts.

## Sections

| #   | Section                                                                          | Covers                                                                                                             |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 01  | [Terminology and roles](spec/01-terminology.md)                                  | Log, observer, subject, aggregator, monitor; identity; federation and the bootstrap allowlist                      |
| 02  | [Attestations](spec/02-attestations.md)                                          | The envelope and all 11 kinds, with field tables                                                                   |
| 03  | [Canonicalization, signing, key discovery](spec/03-canonicalization-and-keys.md) | RFC 8785 JCS, ed25519 signatures, `_ostr.<domain>` TXT records, rotation                                           |
| 04  | [Evidence and spam reporting](spec/04-evidence-and-reporting.md)                 | DKIM admissibility, evidence bundles, retention, batch commitments, challenge sampling, key-observation durability |
| 05  | [Transparency logs](spec/05-logs.md)                                             | RFC 9162-shaped API, STH cadence, MMD, cross-submission, gossip, equivocation                                      |
| 06  | [Scoring](spec/06-scoring.md)                                                    | Tiers, the signal model, policy versioning, deterministic merge order, the emergency lane, cold start and vouching |
| 07  | [Appeals](spec/07-appeals.md)                                                    | The dispute protocol and the three anti-weaponization guards                                                       |
| 08  | [Query and distribution](spec/08-query.md)                                       | DNS TXT answers, `bl.`/`wl.` compatibility views, HTTPS API, snapshots, diff feed, lookup privacy                  |
| 09  | [Privacy floor](spec/09-privacy.md)                                              | The hard rules that bind every role                                                                                |
| 10  | [Threat model](spec/10-threat-model.md)                                          | Named threats, mitigations, and the residual risks we do not solve                                                 |
| 11  | [Governance](spec/11-governance.md)                                              | Constitutional rules, the redaction event, spec change control                                                     |

## Version and change control

This document is version 0 of the specification. Version 0 is expected to change
under review; it is not yet frozen for external implementers. The wire artifacts
it defines carry their own versions and change independently:

- the attestation envelope, at `v: 1`,
- the DNS key record, at `v=1`,
- the DNS query answer, at `v=1`,
- the scoring policy, at `ostr-policy-v1`.

Attestation envelope changes that are not backward compatible require a new `v`
value; policy changes follow the cadence and overlap rules in
[06-scoring](spec/06-scoring.md). The constitutional rules in
[11-governance](spec/11-governance.md) bind changes to this document itself.

## Related material

- Plan: `TRUST_REGISTRY_PLAN_2026-08-20.html` at the repository root.
- Decision record: [ADR-0058](../adr/0058-open-sender-trust-registry.md).
- Reference code: `packages/ostr-core` (schema, canonicalization, signing,
  Merkle primitives, scoring policy), `packages/ostr-client`,
  `packages/ostr-observer`, `apps/ostr-registry`.
- Directory overview: [README](README.md).
