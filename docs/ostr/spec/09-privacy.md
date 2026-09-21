# 09. Privacy floor

[Index](../spec-v0.md) · prev: [08. Query and distribution](08-query.md) · next:
[10. Threat model](10-threat-model.md)

These rules are hard. They bind every role, they are constitutional
([11-governance](11-governance.md)), and no configuration flag, contract or
court-friendly reading relaxes them. A deployment that violates one is not a
conformant OSTR deployment, whatever else it does correctly.

## 9.1 The public record

The public log carries domains, IPs, counts, rates, hashes and commitments.

It MUST NOT carry:

- message bodies, or any part of one,
- subject lines,
- recipient addresses, reporter addresses, or any other mailbox identifier,
- per-message records of any kind,
- spam-trap addresses,
- anything traceable to an individual mailbox user.

`ExplanationGroup.summary` and the free-text fields of `appeal`, `response`,
`retraction`, `vouch` and `audit-finding` are part of the public record and are
bound by the same list. Prose is not an exemption.

## 9.2 Aggregation before publication

- An observer MUST NOT publish a `spam-report-batch` or `traffic-summary` until
  the window meets the k-anonymity floor for distinct traffic and distinct
  reporters ([04 §4.5](04-evidence-and-reporting.md)). Windows widen
  automatically until the threshold is met.
- Counts that could single out one user MUST travel as log-scale buckets
  ([02 §2.3.1](02-attestations.md)).
- Observer mode MUST default to off, MUST warn below its declared mailbox-count
  threshold, and SHOULD refuse to run there. The threshold and the k-anonymity
  floors above it are deployment values at v1, published rather than carried in
  `POLICY_V1` ([06 §6.6](06-scoring.md)). For a single-mailbox observer
  the observer identity is the user identity, and no amount of bucketing repairs
  that.

## 9.3 Evidence bundles

- Bundles stay with the capturing observer, encrypted at rest.
- Bundles MUST NOT be published, shared between observers, sold, or given to the
  accused subject, under any procedure defined here.
- Openings go to adjudicating monitors only, are sampled rather than complete,
  and are logged publicly as events with no contents
  ([04 §4.4](04-evidence-and-reporting.md)).
- Monitors MUST NOT retain opened bundles past the adjudication and MUST NOT use
  them for anything else.
- Retention is capped, illustratively 90 days. An observer MUST NOT keep bundles
  as a general archive; the appeal window is bounded to match
  ([07 §7.2](07-appeals.md)).

## 9.4 Consumers

- Lookups leak the querier's correspondents, so the reference client MUST prefer
  the local snapshot and diff feed and fall back to DNS only on cache misses
  ([08 §8.3](08-query.md)).
- Aggregators MUST NOT publish, sell or share query logs, and SHOULD retain them
  only as long as abuse control needs, in aggregate form.
- Reading the registry MUST NOT require identification of any kind.

## 9.5 What this costs, honestly

Privacy here is bought with precision, and the trade is real rather than
rhetorical:

- Bucketing costs freshness and resolution. Small observers' evidence lands in
  coarse buckets and moves scores slowly.
- Window widening delays evidence from exactly the small, well-run instances the
  registry most wants to include.
- The commitment scheme hides batch contents by design, so cross-observer
  duplicate detection at scoring time does not exist. Duplicates surface only in
  challenge openings ([10-threat-model](10-threat-model.md)).
- Adjudicating monitors see sampled recipient data. Bounded, logged, minimized,
  and not eliminated.

We took these costs deliberately. The alternative designs that recover the
precision all end with per-message records or reporter identities somewhere
readable, and there is no version of that we would be willing to run against our
own users' mailboxes.
