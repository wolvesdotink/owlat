# 08. Query and distribution

[Index](../spec-v0.md) · prev: [07. Appeals](07-appeals.md) · next:
[09. Privacy floor](09-privacy.md)

Four ways to read the registry: DNS for MTAs, `bl.`/`wl.` views for MTA
configuration that already exists, HTTPS for anything rich, and signed snapshots
for consumers who would rather not tell anyone what mail they receive.

## 8.1 DNS

```
# domain query                      # IP query, reversed, DNSBL style
dig TXT example.com.q.ostr.example  dig TXT 7.2.0.192.ip.q.ostr.example
```

A single TXT answer, one record, cacheable:

```
"v=1; tier=trusted; score=87; policy=ostr-policy-v1; asof=2026-08-20T06:00:00Z; ref=https://ostr.example/s/example.com"
```

| Tag      | Required | Value                                                                          |
| -------- | -------- | ------------------------------------------------------------------------------ |
| `v`      | yes      | `1`. Aggregators SHOULD write it first; clients MUST NOT depend on tag order   |
| `tier`   | yes      | One of the five tier names                                                     |
| `score`  | yes      | Integer 0 to 100                                                               |
| `policy` | yes      | The policy version that produced it, `ostr-policy-vN`                          |
| `asof`   | yes      | RFC 3339 timestamp of the as-of head set ([06 §6.2](06-scoring.md)), see below |
| `ref`    | no       | HTTPS URL for the full explanation                                             |

`asof` is an RFC 3339 UTC date-time in the form of
[02 §2.1](02-attestations.md), seconds included. Its value is the `timestamp`
of the declared head the answer was scored against. When the as-of set holds
several heads it is the **oldest** of their timestamps, because that is the
instant up to which every trusted log has been accounted for; a client comparing
two aggregators' answers is comparing coverage, and the newest head would
overstate it. The full set, log by log, is served over HTTPS (§8.2): one TXT
record has no room for it, and no consumer should be reconstructing it from a
summary.

Rules:

- Aggregators MUST answer with exactly one TXT record per name, so the answer
  fits a single UDP response and needs no reassembly logic in an MTA.
- Unknown tags MUST be ignored by clients, so the answer can grow.
- A subject with no evidence MUST get either `tier=unknown` or NXDOMAIN, and the
  aggregator MUST document which. Clients MUST treat both the same way.
- The zone MUST be DNSSEC-signed, so a resolver can verify which aggregator said
  what. For a large, hourly-churning zone that means online signing with NSEC3
  or compact denial of existence. That is an accepted operational cost, not an
  optional extra.
- TTLs around one hour for hot entries. A client MUST honour TTLs and MUST NOT
  pin answers past them.

### `bl.` and `wl.` compatibility views

The DNSBL convention is an A record, not TXT, and stock MTA blocklist machinery
expects `127.0.0.x`. Aggregators therefore MUST also serve:

| Zone              | Answers for             | Meaning                                         |
| ----------------- | ----------------------- | ----------------------------------------------- |
| `bl.ostr.example` | `flagged` subjects only | A `127.0.0.x` A record, in the DNSBL convention |
| `wl.ostr.example` | `trusted` subjects only | A `127.0.0.x` A record, in the DNSWL convention |

Both views MUST be derived from the same scored set as the TXT zone, at the same
as-of head set. An operator MUST NOT hand-edit either view; that would be
exactly the opaque editorial listing this registry replaces.

This is the single most important adoption lever in the design. An existing
Postfix or Rspamd configuration consumes OSTR through these views with zero code
changes, and the TXT zone carries the rich answer for clients that parse it.

## 8.2 HTTPS

```
GET  /v1/subject/example.com           -> tier, score, explanation[], evidence refs, history
GET  /v1/subject/example.com/evidence  -> paginated attestations with inclusion proofs
POST /v1/attestations                  -> submit any signed, well-formed attestation
GET  /v1/log/sth                       -> current signed tree head
GET  /v1/log/proof/...                 -> inclusion and consistency proofs
```

- Every scored answer MUST carry the policy version and the as-of head set.
- `/v1/subject/{s}` MUST return the same `ScoreResult` the DNS view summarizes.
  A discrepancy between the two views of one aggregator is a defect. It is not
  reportable as an `audit-finding`: that body's `evidence` is `LogEntryRef[]`
  ([02 §2.3.10](02-attestations.md)) and an aggregator's DNS answer is not a log
  leaf. A monitor that finds one SHOULD publish it the way it publishes any
  recomputation mismatch, naming the entries the two views disagree about and
  describing the mismatch in `statement`, and the DNSSEC signature on the zone
  is what makes the answer attributable in the meantime.
- The evidence endpoint MUST serve inclusion proofs alongside attestations, so a
  client can verify without trusting the aggregator.
- The API MUST be readable anonymously, without registration, API keys or
  payment. Rate limits are permitted and MUST be published. Paid tiers may buy
  rate limits and support; they MUST NOT buy standing, ordering, or earlier
  data ([11-governance](11-governance.md)).

## 8.3 Snapshots and the diff feed

- Aggregators SHOULD publish a signed daily snapshot of the full scored set in a
  compact columnar format, so a receiver can run entirely from local data.
- Aggregators SHOULD publish an append-only diff feed between snapshots for
  cheap incremental sync.
- Snapshots and diffs MUST be signed and MUST carry the policy version and
  as-of head set. A client MUST verify the signature before use.
- Snapshots MUST be openly downloadable. They are also the fork path: if the
  reference aggregator goes bad, the data to replace it is already in everyone's
  hands ([11-governance](11-governance.md)).

### Why the snapshot path exists

A DNS lookup tells the resolver, and everyone on the path, who is sending you
mail. Over a working day that is a readable map of your correspondents. The
snapshot path is therefore a privacy feature, not a performance optimization.

The reference client library MUST prefer a local snapshot plus the diff feed,
and fall back to DNS only for cache misses. Documentation MUST say why, because
an operator who does not know the reason will happily switch the default for a
few milliseconds and hand over the map.

## 8.4 Consumer-side re-weighting

The default score is a convenience, not a mandate (plan §3). A consumer MAY
apply its own observer weights, ignore observers entirely, or run a stricter
local policy on top of the published one; the reference client is expected to
support it from Phase 3 ([README](../README.md)). Nothing here gives an
aggregator a way to prevent that, and that is deliberate: a registry a receiver
cannot overrule is the chokepoint this design exists to avoid.

The cost of that freedom is stated with it. A re-weighted score is a local
score. It is no longer the reproducible default answer, two consumers with
different weights are not comparing the same number, and a consumer MUST NOT
publish or redistribute one as if it were the aggregator's `ScoreResult`. Local
weights belong to the delivery decision, which was always local; the published
arithmetic stays the common reference anyone can recompute.
