# 05. Transparency logs

[Index](../spec-v0.md) · prev:
[04. Evidence and reporting](04-evidence-and-reporting.md) · next:
[06. Scoring](06-scoring.md)

OSTR logs are Certificate Transparency logs with a different leaf type. Nothing
here is novel, which is the point: RFC 9162's tree, proofs and monitor model
have been attacked in public for a decade and the failure modes are known.

## 5.1 Tree and leaves

- A log MUST maintain an append-only Merkle tree as defined by RFC 9162 §2,
  with `sha256(0x00 || leaf)` for leaves and `sha256(0x01 || left || right)` for
  internal nodes.
- A leaf MUST be the RFC 8785 canonical bytes of the signed attestation,
  including `sig` ([03](03-canonicalization-and-keys.md)).
- Leaf indices are zero-based, permanent, and assigned in the order the log
  sequences submissions.
- A log MUST NOT remove, reorder or renumber a leaf. The only sanctioned
  withholding is a redaction event, which keeps the leaf hash in the tree and
  publishes the event itself ([11-governance](11-governance.md)).

## 5.2 Submission and acceptance

Four conditions are necessary. A log MUST reject a submission unless all of
them hold:

1. the document parses as JSON with no duplicate member names,
2. it re-canonicalizes without error,
3. `v` is `1`, `kind` is one of the eleven kinds, and the envelope and body
   shapes are valid ([02](02-attestations.md)),
4. the `sig` verifies against a key published at `_ostr.<observer>`.

They are not sufficient on their own: acceptance is additionally subject to the
log's published rate and size limits, which a log MAY apply per submitting
domain and MUST publish. Rate and size are the only grounds on which a
submission satisfying all four conditions may be refused.

Criterion 3 includes the kind, and that is a deliberate narrowing of content
neutrality rather than a hole in it. The kind set is closed at `v: 1`, so a log
that accepted an unknown kind would be storing a permanent, signed record whose
body no implementation can validate, while claiming to have validated form.

Beyond form, a log MUST NOT judge whether the claim is true, whether the
observer is reputable, or whether the counts look plausible. Content neutrality
is what keeps the log legally separable from the aggregator and what stops a log
operator becoming an editor. Suspicion belongs to monitors, which say so on the
record with an `audit-finding`.

On acceptance, the log MUST return a signed promise of inclusion, the
CT `SCT` equivalent, signed with the log's key over

```
canonicalBytes({ leafHash, logId, mmdSeconds, timestamp,
                 type: "inclusion-promise", v: 1 })
```

where `leafHash` is `sha256(0x00 || leaf)` in lowercase hex and `mmdSeconds` is
the log's published MMD, so the promise states its own deadline. The log MUST
then include the leaf within that **maximum merge delay** (MMD). An MMD of 24
hours is the illustrative default; a log MUST publish its own value and MUST
honour it. Failure to merge within the MMD is a log-misbehaviour finding with
the promise as the proof. `signInclusionPromise()` in
`packages/ostr-core/src/merkle/promise.ts` is the reference implementation.

## 5.3 Signed tree heads

- A log MUST publish a signed tree head (STH) on a fixed cadence, at least
  hourly, and MUST publish one after the MMD elapses even when nothing was
  submitted, so silence is distinguishable from a stalled log.
- A log MUST NOT publish two STHs with the same tree size and different root
  hashes. That is equivocation, and it is the one unforgivable act in this
  system.
- STHs MUST be retained and served indefinitely, so a proof produced today still
  verifies years later.

An STH is a JSON object with exactly these members:

| Field       | Type     | Meaning                                                                                                         |
| ----------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `v`         | `1`      | Signed-document version, RFC 9162 §4.10's `version`. A verifier MUST reject any other value                     |
| `type`      | `'sth'`  | Signature-type tag, RFC 9162 §4.10's `signature_type`. Domain separation, see below                             |
| `logId`     | `string` | The issuing log's ID ([01 §1.3](01-terminology.md)). Signed, so an STH cannot be replayed as another log's head |
| `treeSize`  | `number` | Non-negative integer count of leaves the head commits to                                                        |
| `rootHash`  | `string` | Merkle tree hash of the first `treeSize` leaves, lowercase hex sha256                                           |
| `timestamp` | `string` | When the head was issued, RFC 3339 UTC in the form of [02 §2.1](02-attestations.md)                             |
| `sig`       | `string` | `ed25519:` plus base64 of the signature below                                                                   |

The signed payload is stated verbatim rather than as "the STH minus `sig`",
because a second implementation must reproduce it byte for byte:

```
sig = "ed25519:" || base64( Ed25519-Sign( logKey,
        canonicalBytes({ logId, rootHash, timestamp, treeSize,
                         type: "sth", v: 1 }) ) )
```

RFC 8785 sorts those six members by name, so the order written above — `logId`,
`rootHash`, `timestamp`, `treeSize`, `type`, `v` — is the order that gets
signed. `treeHeadSigningBytes()` in
`packages/ostr-core/src/merkle/sth.ts` is the reference implementation. An
implementation that omits `logId` produces signatures no conformant verifier
accepts, and so does one that omits `v` and `type`.

`v` and `type` are covered by the signature for the same reason RFC 9162 covers
`version` and `signature_type`: without them, one log key signing several kinds
of document has no way to stop a signature over one being presented as a
signature over another. The inclusion promise of §5.2 carries the same pair,
with `type` of `inclusion-promise`.

## 5.4 Proofs

A log MUST serve, over HTTPS, with RFC 9162 semantics:

| Endpoint                                  | Returns                                             |
| ----------------------------------------- | --------------------------------------------------- |
| `GET /v1/log/sth`                         | The current signed tree head                        |
| `GET /v1/log/proof/inclusion?hash=&size=` | Inclusion proof for a leaf hash against a tree size |
| `GET /v1/log/proof/consistency?from=&to=` | Consistency proof between two tree sizes            |
| `GET /v1/log/entries?start=&end=`         | Leaves in a range, for monitors tailing the log     |
| `POST /v1/attestations`                   | Submit; returns the inclusion promise               |

Verifiers MUST check proofs themselves. A client that fetches a score from an
aggregator and skips proof verification is trusting the aggregator, which the
whole design exists to avoid.

The interface is what matters, not the storage engine (plan D1). The first
implementation is an embedded Merkle store inside `apps/ostr-registry`. An
operator MAY run Trillian, Rekor, or anything else behind the same API; monitors
cannot tell the difference and MUST NOT depend on being able to.

## 5.5 Cross-submission

A submitter MUST send each attestation to every log in its declared submission
set, and that set MUST hold at least two independent logs from Phase 2 onward
([README phase table](../README.md)). Until a second independent log exists, the
requirement is SHOULD and a deployment MUST declare the minimum it runs with.
Phases 0 and 1 ship a single-node log, so a MUST here would make the reference
deployment non-conformant on its first day, and a specification whose own
reference implementation violates it teaches implementers to skim the MUSTs.

- Independence means distinct operators, not distinct host names.
- The same attestation submitted to several logs is one attestation with several
  `LogEntryRef`s. Scoring MUST count it once, deduplicating on the canonical
  bytes of the signed record, keeping the earliest `loggedAt` it can prove and
  the union of the coordinates for the explanation. The merge that does it is
  specified in [06 §6.2](06-scoring.md); without it, cross-submission would
  inflate every submitter's evidence by the number of logs it reaches.
- Cross-submission is what makes a single log's outage or misbehaviour lose
  nothing. It also means a log that starts censoring submissions is visible: the
  evidence shows up elsewhere and its absence in one log is checkable.

## 5.6 Gossip and equivocation

Equivocation is a log showing different histories to different audiences. It is
undetectable from inside one view, so detection is a network property:

- Monitors MUST gossip STHs with each other, and SHOULD gossip STHs they
  received via clients and aggregators.
- On two STHs from one log with the same tree size and different roots, or with
  sizes whose consistency proof fails, a monitor MUST publish an
  `audit-finding` with `finding: 'equivocation'` and the two STHs as evidence.
- The proof is self-contained: two signatures by the same log key over
  contradictory heads. Anyone can check it, and no adjudication is required.
- A proven equivocation MUST remove the log from the default trusted set of a
  conformant aggregator, and evidence that exists **only** in that log MUST stop
  counting. Evidence cross-submitted elsewhere survives, which is the second
  reason for §5.5. While a deployment runs one log, that rule takes the whole
  evidence set with it, which is the honest cost of the Phase 0 and 1 topology
  and the reason cross-submission becomes a MUST at Phase 2.
- Reinstatement is a governance action, on the record, never an aggregator's
  private decision.

Aggregators MUST publish which logs they trust and which tree heads they scored
against. A score is only reproducible against a declared head set
([06 §6.2](06-scoring.md)), so an aggregator that hides its head set is not
producing a verifiable answer.
