# 02. Attestations

[Index](../spec-v0.md) · prev: [01. Terminology](01-terminology.md) · next:
[03. Canonicalization and keys](03-canonicalization-and-keys.md)

One record type, eleven kinds. Every attestation is a JSON document signed by
its author's registry key and submitted to every log in the submitter's declared
set, which holds at least two independent logs from Phase 2 onward
([05 §5.5](05-logs.md)). The declarations in this section are normative and are
mirrored exactly by `packages/ostr-core/src/types.ts`; a field name, optionality
or type that differs between the two is a bug in whichever changed last.

## 2.1 The envelope

```json
{
	"v": 1,
	"kind": "traffic-summary",
	"observer": "mx.hinterland.camp",
	"subject": { "domain": "example.com" },
	"window": { "from": "2026-08-19T00:00:00Z", "to": "2026-08-20T00:00:00Z" },
	"body": {
		"messages": 1284,
		"spfPass": 1284,
		"dkimPass": 1280,
		"dmarcPass": 1280,
		"tlsInbound": 1284,
		"uniqueRecipientsBucket": 2,
		"bounceRateBucket": 0
	},
	"sig": "ed25519:jQmowcrASfUAZt/eh4SZY+9fRl5ns1MCc8s/Rp6S/huAWnfTnLvv84eYpLQY/Zz/hTh0+obIrsg/yxjp6r4sAg=="
}
```

| Field      | Type                 | Required | Rules                                                                                                                                                                                                                                                                                        |
| ---------- | -------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`        | `1`                  | yes      | Envelope version. A verifier MUST reject any other value rather than guessing                                                                                                                                                                                                                |
| `kind`     | `AttestationKind`    | yes      | One of the eleven strings in §2.2. The set is closed at `v: 1`: an unknown kind MUST be rejected by verifiers **and** by logs. Content neutrality is about the claim, not the schema, and a log that cannot check a body it has no schema for is not validating form ([05 §5.2](05-logs.md)) |
| `observer` | `string`             | yes      | Author domain, lowercase A-label. Signing key discoverable at `_ostr.<observer>`. Named `observer` for every kind, including those authored by a subject or monitor                                                                                                                          |
| `subject`  | `SubjectRef`         | yes      | `{ domain?, ip? }`. At least one member MUST be present                                                                                                                                                                                                                                      |
| `window`   | `AttestationWindow`  | no       | `{ from, to }`, RFC 3339 UTC (see below), half-open `[from, to)`. REQUIRED for `traffic-summary`, `spam-report-batch` and `trap-hit`; OPTIONAL elsewhere                                                                                                                                     |
| `body`     | kind-specific object | yes      | See §2.3                                                                                                                                                                                                                                                                                     |
| `sig`      | `string`             | yes      | `ed25519:` plus base64 of the signature over the canonical form with `sig` absent ([03](03-canonicalization-and-keys.md))                                                                                                                                                                    |

`UnsignedAttestation` is the same document with `sig` absent. It is the input to
signing and to verification, and it is what a submitter builds.

`SubjectRef` carries `domain`, `ip`, or both. A verifier MUST reject an empty
`SubjectRef`. A `domain` MUST be a lowercase A-label FQDN, and an `ip` MUST be
an IPv4 or lowercase IPv6 literal, published in the canonical text form of
[01 §1.2](01-terminology.md).

`AttestationWindow` is half-open `[from, to)`. `from` MUST NOT be later than
`to`; an equal pair is well formed and carries no evidence.

**One instant, one spelling.** Every timestamp an attestation carries, window
bounds included, MUST be an RFC 3339 date-time in UTC: uppercase `T`, trailing
`Z`, at most millisecond precision, no leap second. RFC 3339 also admits
`2026-08-19t00:00:00z` and `2026-08-19T02:00:00+02:00` for that same moment, and
a verifier MUST reject both rather than normalizing them. The bytes are what
gets signed, so three spellings of one instant would be three different signed
records, and a consumer comparing bounds as strings would order them wrongly.
Producers holding a timestamp in another form convert before signing.

**Extensibility: none, inside `v: 1`.** A member that is not in the table above,
or not in the body table for the kind, MUST cause rejection at every level, by
logs and verifiers alike. A log entry is permanent, signed and stored by
everyone forever, so unscored payload does not get to ride along inside it, and
an implementation that accepts an unknown member disagrees with every other
implementation about which records are admissible. Adding a field or a kind
therefore requires a new envelope `v` and the migration window in
[11 §11.5](11-governance.md). DNS is the deliberate exception, because it is a
different artifact with a different lifetime: unknown tags in a `_ostr` key
record MUST be ignored ([03 §3.3](03-canonicalization-and-keys.md)).

**Who enforces what.** Rules in this section that relate one field to another,
such as §2.3.5's `subject.domain` equals `body.domain` and §2.3.6's
self-authorship, bind verifiers and aggregators rather than logs. A log checks
envelope shape and signature only ([05 §5.2](05-logs.md)), so a record that
breaks a cross-field rule is sequenced and then refused admission at scoring,
on the record, rather than being invisible.

## 2.2 Kinds

| Kind                | Author role         | Feeds                                                         |
| ------------------- | ------------------- | ------------------------------------------------------------- |
| `traffic-summary`   | observer            | Volume, authentication hygiene, consistency                   |
| `spam-report-batch` | observer            | Complaint rate                                                |
| `trap-hit`          | observer            | List hygiene, negative                                        |
| `key-observation`   | observer            | Evidence durability ([04 §4.6](04-evidence-and-reporting.md)) |
| `posture`           | subject             | Hygiene baseline, cold start                                  |
| `vouch`             | any scored party    | Cold start ([06 §6.5](06-scoring.md))                         |
| `vouch-revoke`      | the voucher         | Cold start                                                    |
| `appeal`            | subject             | Dispute resolution ([07](07-appeals.md))                      |
| `response`          | the named observer  | Dispute resolution                                            |
| `retraction`        | the original author | Correction without deletion                                   |
| `audit-finding`     | monitor             | Observer and log weighting                                    |

## 2.3 Bodies

### 2.3.1 Counts and buckets

Raw counts appear only where they cannot single out one mailbox user. Everything
else travels as a log-scale bucket. `LogScaleBucket` is a non-negative integer,
and its encoding is normative:

```
bucket(n) = 0                for 0 <= n < 10
bucket(n) = floor(log10(n))  for n >= 10
```

Bucket 0 covers 0 through 9, bucket 1 covers 10 through 99, bucket 2 covers 100
through 999. `bucket(0)` is 0 by definition rather than by arithmetic, since
`log10 0` has no value and "nothing" and "fewer than ten" are indistinguishable
at this resolution anyway.

One field is not a count of things and therefore does not use that function.
`bounceRateBucket` carries the decade of a **percentage**, and `POLICY_V1.bounce`
reads it that way:

| Value | Bounce and invalid-recipient rate |
| ----- | --------------------------------- |
| `0`   | under 1%                          |
| `1`   | 1% to under 10%                   |
| `2`   | 10% and above                     |

No value above 2 is defined; a producer whose rate exceeds the top band MUST
publish `2`.

Producers MUST NOT publish a bucket that is finer than the k-anonymity floor in
[09-privacy](09-privacy.md) permits.

### 2.3.2 `traffic-summary` (`TrafficSummaryBody`)

| Field                    | Type             | Required | Meaning                                                                    |
| ------------------------ | ---------------- | -------- | -------------------------------------------------------------------------- |
| `messages`               | `number`         | yes      | Messages received from the subject in the window                           |
| `spfPass`                | `number`         | yes      | Of those, SPF pass                                                         |
| `dkimPass`               | `number`         | yes      | Of those, DKIM pass                                                        |
| `dmarcPass`              | `number`         | yes      | Of those, DMARC pass                                                       |
| `tlsInbound`             | `number`         | yes      | Of those, delivered over TLS                                               |
| `uniqueRecipientsBucket` | `LogScaleBucket` | yes      | Distinct recipients, log-scale                                             |
| `bounceRateBucket`       | `LogScaleBucket` | yes      | Bounce and invalid-recipient rate, as the percent decade defined in §2.3.1 |

Each pass count MUST be less than or equal to `messages`. A `traffic-summary`
is the denominator for every rate the policy computes, so an observer MUST
publish one for a `(subject, window)` pair before, or in the same submission as,
any `spam-report-batch` for that pair ([04 §4.4](04-evidence-and-reporting.md)).

### 2.3.3 `spam-report-batch` (`SpamReportBatchBody`)

| Field        | Type     | Required | Meaning                                                      |
| ------------ | -------- | -------- | ------------------------------------------------------------ |
| `reports`    | `number` | yes      | User-initiated, DKIM-evidence-backed reports in the window   |
| `commitment` | `string` | yes      | Merkle root over the per-report evidence bundles, hex sha256 |

`commitment` MUST be computed as specified in
[04 §4.3](04-evidence-and-reporting.md) and MUST commit to exactly `reports`
leaves.

### 2.3.4 `trap-hit` (`TrapHitBody`)

| Field  | Type     | Required | Meaning                                               |
| ------ | -------- | -------- | ----------------------------------------------------- |
| `hits` | `number` | yes      | Messages delivered to never-subscribed trap addresses |

Trap addresses MUST NOT appear anywhere in the public record. Trap evidence is
admissible only from observers above an operator size floor, which
`ostr-policy-v1` does not carry and each deployment therefore declares
([06 §6.6](06-scoring.md)). A challenged trap hit burns that trap address, and
v1 defines no trap-sharing scheme (plan D7). Traps are a bonus signal;
complaint rate carries the load.

### 2.3.5 `key-observation` (`KeyObservationBody`)

| Field             | Type      | Required | Meaning                                                               |
| ----------------- | --------- | -------- | --------------------------------------------------------------------- |
| `domain`          | `string`  | yes      | The DKIM `d=` domain the key belongs to                               |
| `selector`        | `string`  | yes      | The DKIM selector                                                     |
| `publicKey`       | `string`  | yes      | Base64 SPKI DER of the DKIM public key, or `sha256:<hex>` of that DER |
| `firstSeen`       | `string`  | yes      | RFC 3339, first verification with this key at this observer           |
| `lastSeen`        | `string`  | yes      | RFC 3339, most recent verification                                    |
| `dnssecValidated` | `boolean` | yes      | Whether the DNS chain to the key record validated under DNSSEC        |

`firstSeen` MUST NOT be later than `lastSeen`, and the envelope's
`subject.domain` MUST equal `body.domain`. Both are cross-field rules in the
sense of §2.1: verifiers and aggregators enforce them, logs do not.

### 2.3.6 `posture` (`PostureBody`)

Author is the subject. Every field is a claim a third party can check against
DNS, which is what keeps self-attestation honest.

| Field                  | Type                                                 | Required | Meaning                                                                          |
| ---------------------- | ---------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `dmarcPolicy`          | `'none' \| 'quarantine' \| 'reject'`                 | no       | Published DMARC policy                                                           |
| `dmarcAlignment`       | `'relaxed' \| 'strict'`                              | no       | Published alignment mode                                                         |
| `dnssec`               | `boolean`                                            | no       | Zone is DNSSEC-signed                                                            |
| `mtaSts`               | `boolean`                                            | no       | MTA-STS policy published                                                         |
| `tlsRpt`               | `boolean`                                            | no       | TLS-RPT reporting configured                                                     |
| `declaredIps`          | `string[]`                                           | no       | Sending IPs or ranges the subject claims                                         |
| `registeredBefore`     | `string`                                             | no       | RFC 3339 date the registration is provably at least as old as                    |
| `compromiseDisclosure` | `{ rotatedAt: string; affectedSelectors: string[] }` | no       | Set after a key compromise; scored leniently, see [10 §10.2](10-threat-model.md) |

A `posture` MUST be self-authored to be scored: `observer` equal to
`subject.domain`, which also requires the subject to be a domain rather than a
bare IP. That is the only case in which it is what its name says, a party
describing its own DNS. A posture naming someone else is well formed, and a log
MUST accept it like any other valid record, but an aggregator MUST NOT let it
move the named subject's score in either direction.

Posture is the one signal not weighted by its author's standing
([06 §6.4](06-scoring.md)): a self-declaration every reader can check in DNS
needs no witness, and weighting it by the subject's own standing would be
circular. Third-party posture therefore has no standing to be weighted by, and
since posture only ever adds lift, admitting it at any weight would let a
stranger hand a subject free hygiene points.

An aggregator MUST verify posture claims against DNS before scoring them, MUST
NOT score an unverifiable claim, and MUST record verification failure in the
explanation rather than silently dropping the attestation.

`declaredIps` regroups bare-IP evidence to the declared range (plan D2) and
therefore also imports that range's negative history. Declaring is not a
one-way benefit.

### 2.3.7 `vouch` (`VouchBody`) and `vouch-revoke` (`VouchRevokeBody`)

| Kind           | Field     | Type          | Required | Meaning                                                    |
| -------------- | --------- | ------------- | -------- | ---------------------------------------------------------- |
| `vouch`        | `scope`   | `string`      | yes      | Bounded free text, for example "transactional mail only"   |
| `vouch`        | `expires` | `string`      | yes      | RFC 3339 expiry. A vouch without an expiry is inadmissible |
| `vouch-revoke` | `vouch`   | `LogEntryRef` | yes      | Coordinates of the vouch being revoked                     |
| `vouch-revoke` | `reason`  | `string`      | yes      | Why                                                        |

A `vouch` MUST name someone else. A vouch whose `observer` is the subject it
vouches for is inadmissible and MUST NOT contribute to the subject's score, in
either direction: self-vouching would hand every newcomer the bounded vouch lift
for the price of one more signature, and the whole point of a vouch is that
somebody else's standing is at stake ([06 §6.5](06-scoring.md)).

A `vouch-revoke` MUST be authored by the same `observer` domain as the vouch it
names. Revocation stops future stake accrual; it MUST NOT retroactively erase a
stake hit the voucher already took ([06 §6.5](06-scoring.md)).

### 2.3.8 `appeal` (`AppealBody`) and `response` (`ResponseBody`)

| Kind       | Field       | Type                             | Required | Meaning                                            |
| ---------- | ----------- | -------------------------------- | -------- | -------------------------------------------------- |
| `appeal`   | `contested` | `LogEntryRef[]`                  | yes      | The attestations being disputed. MUST be non-empty |
| `appeal`   | `statement` | `string`                         | yes      | The subject's account                              |
| `response` | `appeal`    | `LogEntryRef`                    | yes      | The appeal being answered                          |
| `response` | `outcome`   | `'substantiated' \| 'retracted'` | yes      | Result of the observer's own review                |
| `response` | `statement` | `string`                         | yes      | Reasoning, minus any bundle content                |

A `response` MUST be authored by the observer that authored the contested
attestations. A `response` with `outcome: 'retracted'` MUST be accompanied by a
`retraction` for each contested entry. Statements MUST NOT contain evidence
bundle material; the privacy floor applies to appeal prose exactly as it does to
everything else.

### 2.3.9 `retraction` (`RetractionBody`)

| Field        | Type          | Required | Meaning                         |
| ------------ | ------------- | -------- | ------------------------------- |
| `supersedes` | `LogEntryRef` | yes      | The attestation being withdrawn |
| `reason`     | `string`      | yes      | Why                             |

Authored by the original author. The superseded attestation stays visible in the
log and stops counting from the retraction's own log position onward. Nothing is
ever deleted, so a delisting always leaves a history, which is the property that
makes quiet pay-to-delist schemes impossible to run.

### 2.3.10 `audit-finding` (`AuditFindingBody`)

| Field       | Type                                                                                                                 | Required | Meaning                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ |
| `finding`   | `'equivocation' \| 'invalid-attestation' \| 'statistical-outlier' \| 'unanswered-challenge' \| 'duplicate-evidence'` | yes      | The claim, from a closed set                                 |
| `evidence`  | `LogEntryRef[]`                                                                                                      | yes      | Coordinates of the material supporting it. MUST be non-empty |
| `statement` | `string`                                                                                                             | yes      | Human-readable summary                                       |

Every value of `finding` names something a third party can check mechanically.
That is deliberate: monitors publish checkable claims, not opinions, and an
aggregator MUST re-verify a finding before letting it move any weight.

## 2.4 Log coordinates and sequenced entries

| Type                   | Fields                                                                           | Meaning                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `LogEntryRef`          | `logId: string`, `index: number`                                                 | A specific leaf in a specific log                                                                    |
| `SequencedAttestation` | `logId: string`, `index: number`, `loggedAt: string`, `attestation: Attestation` | A leaf as the scoring policy consumes it. `loggedAt` is the RFC 3339 inclusion time the log assigned |

`loggedAt` comes from the log, never from the author. Scoring MUST order entries
by log coordinate and MUST NOT let an author-supplied `window` decide order: a
submitter controls its own clock and does not control the log's. Decay is the
one place a `window` is allowed to speak, because the age of evidence about a
period is the age of that period: where a record carries a window, decay MAY be
measured from `window.to`, and where it does not, the age reference is
`loggedAt`. What makes that safe is the skew bound below, which ties `window.to`
to the log's own clock.

That leaves the author's clock to bound, because an unbounded `window` is a way
to claim the future. Two admissibility rules, neither owed by the log (§2.1):

- An attestation whose `window.to` is later than its own `loggedAt` by more than
  the deployment's declared clock-skew tolerance MUST be refused admission. The
  tolerance is a deployment value, not a `POLICY_V1` constant
  ([06 §6.6](06-scoring.md)); it exists for honest clock drift, not for
  forecasts. This one belongs to the verifier or aggregator: the policy has no
  deployment constants.
- An attestation whose `window` has not closed at the evaluation instant, that
  is `window.to` after `asOf`, MUST NOT be scored at that instant. It becomes
  admissible when the window closes, without being resubmitted. This one is a
  pure function of the entry and `asOf`, so the scoring policy enforces it
  itself, in the same pass that drops entries logged after `asOf`
  ([06 §6.2](06-scoring.md)). An aggregator MAY drop such entries earlier; it
  MUST NOT assume it is the only layer that does.

## 2.5 Scoring output

Defined here because it is a wire type, and specified in
[06-scoring](06-scoring.md).

| Type               | Fields                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `Tier`             | `'unknown' \| 'establishing' \| 'trusted' \| 'warned' \| 'flagged'`                                                  |
| `ExplanationGroup` | `signal: string`, `contribution: number`, `summary: string`, `evidence: LogEntryRef[]`                               |
| `ScoreResult`      | `subject: SubjectRef`, `tier: Tier`, `score: number` (0 to 100), `policy: string`, `explanation: ExplanationGroup[]` |

`ExplanationGroup.summary` MUST be deterministic: no computation timestamps, no
locale-dependent formatting, no ordering that depends on hash-map iteration. Two
conformant aggregators produce the same sentence or one of them is wrong.
