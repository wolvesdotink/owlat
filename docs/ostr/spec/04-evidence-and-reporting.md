# 04. Evidence and spam reporting

[Index](../spec-v0.md) · prev:
[03. Canonicalization and keys](03-canonicalization-and-keys.md) · next:
[05. Transparency logs](05-logs.md)

The registry's sharpest departure from the status quo: a spam report counts only
with cryptographic proof that the accused actually sent the message. Everything
in this section exists to make report-bombing infeasible rather than merely
forbidden, without putting a single mailbox user's action on the public record.

## 4.1 DKIM admissibility (plan §7.1)

A valid DKIM signature is an existence proof. The holder of the private key for
`d=example.com` signed this header set and this body hash, so anyone with the
key can answer "did example.com send this?" without trusting the reporter.

DKIM was designed for transit-time authentication, not durable
non-repudiation, so its edge cases are admissibility rules here rather than
footnotes. An observer MUST NOT count a report toward `spam-report-batch.reports`
unless every rule below holds, and a monitor MUST re-check them at every
challenge opening.

| Rule                 | Requirement                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Verification result  | The signature MUST have verified at receipt, against a key the observer resolved at that time                               |
| `l=` body-length tag | A signature carrying `l=` is **inadmissible**. It does not bind appended content, so the message shown may be half unsigned |
| Key strength         | RSA keys below 2048 bits are **inadmissible**. Ed25519 (RFC 8463) is admissible                                             |
| Header coverage      | The `h=` list MUST cover at least `From`, `Date` and `Message-ID`. A signature missing any of the three is inadmissible     |
| Domain match         | The signature's `d=` MUST equal the batch's `subject.domain`                                                                |
| Expiry               | An `x=` value that had already passed at receipt makes the signature inadmissible                                           |
| Duplicates           | Within one observer, a report whose `(Message-ID, bh=)` pair was already counted MUST be dropped at capture, not at scoring |

The strength floor tracks current practice rather than this document's
publication date. `ostr-policy-v1` does not carry it: 2048 bits is the operative
floor at v1, declared here, and a deployment MAY require more
([06 §6.6](06-scoring.md)). Folding it into a policy version is the intended
route for the next raise, so that a floor change is a dated, diffable policy
event rather than a spec edit.

Unsigned spam does not vanish, it just leaves this path. It is scored through
the IP-side signals and authentication-failure counts, which are weaker on
purpose ([10 §10.3](10-threat-model.md)).

## 4.2 Evidence bundles and retention (plan §7.2)

When a user reports spam, the observer assembles an evidence bundle locally. The
reporting action in the user's client MUST NOT gain friction from any of this;
capture happens behind the existing junk action.

A bundle is a JSON object with exactly the members below. It is hashed as its
RFC 8785 canonical bytes ([03 §3.1](03-canonicalization-and-keys.md)), which is
what §4.3 commits to, so the schema is normative even though the object itself
is never published: two observers holding the same evidence MUST produce the
same bundle hash, or an opening cannot be adjudicated across implementations.

| Field             | Type                 | Required | Meaning                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`               | `1`                  | yes      | Bundle version, separate from the envelope version and from the policy version                                                                                                                                                                                                                                                                                   |
| `headers`         | `[string, string][]` | yes      | Every header named in the signature's `h=` list, as `[name, value]` pairs, in `h=` order, one pair per named occurrence. `name` verbatim as it appeared, `value` the field body verbatim including internal folding and without the trailing CRLF. An `h=` entry with no matching header instance left is the pair with an empty value, matching RFC 6376 §5.4.2 |
| `dkimSignature`   | `string`             | yes      | The `DKIM-Signature` field body itself, verbatim                                                                                                                                                                                                                                                                                                                 |
| `keyRecord`       | `string`             | yes      | The DKIM key record used at verification, as the raw TXT string with character strings concatenated and no separators                                                                                                                                                                                                                                            |
| `dnssecValidated` | `boolean`            | yes      | Whether the chain to that key record validated under DNSSEC                                                                                                                                                                                                                                                                                                      |
| `verified`        | `boolean`            | yes      | The verification result at receipt. A bundle committed in a batch MUST carry `true`; a monitor re-checks §4.1 admissibility against the rest of the bundle at opening                                                                                                                                                                                            |
| `receivedAt`      | `string`             | yes      | RFC 3339, when the message was received                                                                                                                                                                                                                                                                                                                          |
| `reportedAt`      | `string`             | yes      | RFC 3339, when the user reported it                                                                                                                                                                                                                                                                                                                              |

Ordering inside the object is not a producer concern: canonicalization sorts
members. Ordering inside `headers` is, which is why it is pinned to `h=` order
rather than to receipt order. An unknown member MUST make the bundle
inadmissible at adjudication, for the reason unknown envelope members are
rejected ([02 §2.1](02-attestations.md)).

A bundle MUST NOT contain the message body. The signature's own `bh=` binds it,
so retaining the body would add exposure and no evidentiary value.

The verbatim requirement has a consequence worth stating plainly: `h=` almost
always includes `Subject` and `To`, so bundles contain recipient-identifying
material by construction. Redacting a signed header, for example hashing the
subject, would make the signature unverifiable and destroy the evidence. The
privacy line is therefore drawn at **who may see a bundle**, never inside one.

Retention:

- Observers MUST store bundles encrypted at rest.
- Observers MUST retain bundles for a declared retention window, approximately
  90 days, and SHOULD delete them promptly afterwards. Retention is an
  obligation in both directions. The window is a deployment value at v1, not a
  `POLICY_V1` constant ([06 §6.6](06-scoring.md)), and it MUST be published,
  because the appeal window in [07 §7.2](07-appeals.md) is bounded by it.
- Bundles MUST NOT be published, sold, shared with other observers, or handed to
  the accused subject, ever, under any procedure in this specification.
- An observer that can no longer produce bundles for a batch MUST expect that
  batch to be discarded from scoring on challenge, which is the same outcome as
  fabrication. That symmetry is intentional and is why the appeal window in
  [07](07-appeals.md) is bounded by the retention window.

## 4.3 Batch commitments

What reaches the log is a `spam-report-batch`: counts per subject per window,
plus a Merkle commitment over the bundles. It is computed in two steps, and the
split matters because the tree never sees a bundle:

1. **Hash each bundle.** `bundleHash = sha256(canonicalBytes(bundle))` (§4.2).
   32 bytes.
2. **Commit to the hashes.** Those 32-byte hashes are the leaf data, so
   `leafHash = sha256(0x00 || bundleHash)` and internal nodes are
   `sha256(0x01 || left || right)`, the RFC 9162 tree of
   [05-logs](05-logs.md). Domain separation between leaf and node hashing is
   mandatory.

- `commitment` MUST be the lowercase hex root over exactly `reports` leaves.
- An opening (§4.4) hands the monitor the revealed bundle, its index and an
  inclusion proof. The monitor recomputes `bundleHash` from the bundle it was
  given, hashes that as the leaf, and checks the proof against the published
  root. Collapsing the two steps into `sha256(0x00 || canonicalBytes(bundle))`
  produces a different root and fails every honest opening;
  `verifyBundleOpening()` in `packages/ostr-core/src/merkle/batch.ts` is the
  reference check and takes the 32-byte `bundleHash`.
- Leaves SHOULD be ordered by capture time, then by bundle hash to break ties.
  It is a reproducibility convention rather than an enforceable rule: a sampled
  opening says nothing about the order of the leaves it did not open, so only a
  full opening can test it.
- A batch with `reports: 0` carries no evidence and MUST NOT be published. One
  that exists anyway MUST commit to the empty-tree root, `sha256("")`, hex
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, and MUST
  NOT move any score.
- The commitment hides its contents by construction. An observer MUST NOT be
  able to change what a batch committed to after publication, and no reader
  learns anything from the root alone.

## 4.4 Challenge sampling, and who may see openings (plan §7.2, §7.3)

A batch is a claim until someone tests it. Testing works by opening a random
sample of the committed leaves to adjudicating monitors.

1. **Trigger.** A subject files an appeal ([07](07-appeals.md)), or a monitor
   challenges a batch on its own initiative.
2. **Selection.** The challenger selects sample indices against the published
   commitment. Selection MUST be verifiable by third parties and MUST NOT be
   influenced by the observer. Deriving indices from a hash of
   `(commitment, trigger)` satisfies both, where `trigger` is the appeal's
   `LogEntryRef` or, for a monitor-initiated challenge, the monitor's published
   challenge notice.
3. **Opening.** The observer reveals the selected bundles, with Merkle inclusion
   proofs against `commitment`, to the adjudicating monitors **only**.
4. **Adjudication.** Monitors re-run §4.1 admissibility against the logged key
   observations (§4.6), check for duplicates within the opening, and compare the
   batch's implied complaint rate against the observer's own
   `traffic-summary` and against other observers' volume for the same subject.
5. **Outcome.** The observer publishes the `response`, since a `response` is by
   definition the author of the contested attestations answering for them
   ([02 §2.3.8](02-attestations.md), [07 §7.1](07-appeals.md)). The monitor
   publishes an `audit-finding` when substantiation fails or duplicates surface.
   A failure to substantiate means the batch is discarded from scoring and the
   observer takes a standing penalty, on the record.

Access rules, which are hard:

- Openings go to adjudicating monitors only. The accused subject MUST NOT
  receive raw bundles at any point. The subject receives the verdict and
  aggregate statistics.
- The reason is concrete: a sender can craft per-recipient `Message-ID`s or
  per-recipient content, then appeal, and read the reporters' identities
  straight out of the bundles. Giving the accused the evidence would convert the
  appeal right into a deanonymization tool.
- Monitors MUST treat opened bundles as confidential, MUST NOT retain them
  beyond the adjudication, and MUST NOT use them for any other purpose.
- Every opening MUST be published: that it happened, who adjudicated, which
  batch, at what time. Never the contents. At `v: 1` this is a signed, dated
  notice from the adjudicating monitor, served alongside its findings, because
  the attestation kinds are a closed set and none of them carries an opening
  record ([02 §2.1](02-attestations.md)). A `challenge-opening` kind is a
  candidate for the next envelope version ([11 §11.5](11-governance.md)); until
  then the obligation is the same and the artifact is smaller.
- Sample size MUST be bounded, so challenge cost is proportional to the sample
  and not to the batch. That bound is what keeps appeal flooding from crushing
  volunteer observers ([07](07-appeals.md)). `ostr-policy-v1` does not carry the
  number; each deployment declares it ([06 §6.6](06-scoring.md)).

Residual exposure, stated rather than hidden: adjudicating monitors learn the
sampled recipients. It is bounded by sampling, by confidentiality terms, and by
the public record of every access. It is not eliminated. Zero-knowledge proofs
over DKIM verification were considered and deferred (plan D4); they are heavy
engineering against a leak that is already bounded to a small, named,
accountable set.

## 4.5 The k-anonymity floor, and its own floor (plan §7.4)

An observer MUST NOT publish a `spam-report-batch` or `traffic-summary` for a
window unless that window covers enough distinct traffic and enough distinct
reporters that the log-bucketed counts cannot expose a single user's action.
`ostr-policy-v1` does not carry those thresholds; an observer declares and
publishes its own, at or above any floor its deployment sets
([06 §6.6](06-scoring.md)). When a window falls short, the observer MUST
widen the window and retry rather than publish, and MUST NOT publish the
narrower window later.

Window widening cannot save a small observer, and pretending otherwise would be
the dishonest part of this design:

> For a single-mailbox observer, common among self-hosters, the observer
> identity **is** the user identity. `mx.hinterland.camp` attesting "received
> mail from X, one report" tells X exactly which person reported. No amount of
> widening changes that. Sender-side timing correlation is the same attack in
> slow motion: send unique content to one address, watch that observer's next
> window.

So observer mode MUST ship off by default, and an implementation MUST warn, and
SHOULD refuse, below a declared mailbox-count threshold. The threshold is an
implementation and deployment value at v1 rather than a `POLICY_V1` constant
([06 §6.6](06-scoring.md)), and it MUST be documented where an operator will
see it before turning observer mode on. The intended
fix is pooled submission through an aggregation relay that signs as its own
accountable observer, decided for Phase 2 (plan D6). The relay carries full
challenge obligations, its member instances stay unnamed, and it counts as one
observer for diversity, so stuffing sock-puppet mailboxes into a relay cannot
fake witness diversity.

Until relays exist, small instances consume without contributing. The incentive
model tolerates that explicitly ([01 §1.5](01-terminology.md)).

## 4.6 Evidence durability: keys do not wait for the appeal (plan §7.5)

"Verifiable by anyone with DNS access" is only true near receipt time. DKIM keys
get rotated and removed as ordinary hygiene, and some senders deliberately
publish retired private keys to make old signatures deniable. Both practices are
legitimate, and both break naive challenge-time verification: an appeal 60 days
after receipt finds no key, or finds one anybody could have forged with.

The fix reuses the log. Observers MUST submit a `key-observation` the first time
they verify with a given `(domain, selector, key)` and SHOULD refresh `lastSeen`
periodically while the key stays in use.

Then:

- Challenge-time verification MUST run against the logged key observations that
  were contemporaneous with receipt. It MUST NOT run against live DNS.
- A monitor SHOULD require corroborating key observations from more than one
  observer before treating a key record as established.
- Log sequencing bounds forgery: a batch whose commitment was logged at time T,
  verified against keys observed before T, cannot have been fabricated with a
  key leaked after T. That is the property a bare, untimestamped DKIM signature
  lacks, and it is why durability lives in the log rather than in DNS
  persistence.

Corollary, and it is load-bearing: rotation stays cheap. Frequent key and
selector rotation is the standard DKIM replay defense, it costs a sender nothing
evidentiary here, and "stable keys" is therefore deliberately **not** a scoring
signal. Without this section the design would be telling senders to rotate while
quietly needing them not to.

## 4.7 Where reports arrive: ARF at the observer boundary (plan §2)

This specification governs what an observer publishes, not how a complaint
reaches it. At the observer boundary the format is the one that already exists:
ARF (RFC 5965), as feedback loops and mail clients already emit and consume it,
alongside whatever junk action the observer's own store offers. An observer
SHOULD accept ARF there and MUST NOT require a new report format from anyone.

The delta is what happens next, and it is the entire design. An ARF report
carries no proof that the accused sent the message, so the observer verifies the
signature (§4.1), captures the bundle (§4.2), and publishes a batch with a
commitment (§4.3). The registry-facing artifact is always the batch: an ARF
report MUST NOT be forwarded to a log, an aggregator or another observer,
because it carries reporter and recipient identifiers that the privacy floor
keeps out of the record ([09 §9.1](09-privacy.md)).
