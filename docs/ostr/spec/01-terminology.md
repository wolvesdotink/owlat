# 01. Terminology and roles

[Index](../spec-v0.md) · next: [02. Attestations](02-attestations.md)

## 1.1 Roles

Five roles. Each is a conformance class, so a requirement addressed to "an
observer" binds observer implementations and nobody else. One deployment MAY
fill several roles; it then owes every matching requirement at once.

| Role           | Does                                                                                                                                                                           | Identified by                                   | Trusted for                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Log**        | Accepts well-formed signed attestations, sequences them into an append-only Merkle tree, publishes signed tree heads, serves inclusion and consistency proofs                  | Log ID (see §1.3) and its tree-head signing key | Sequencing and availability only. Never for truth                                          |
| **Observer**   | Submits attestations about mail it actually received: traffic and authentication counts, verified spam-report batches, trap hits, key observations                             | A domain name, with its key at `_ostr.<domain>` | Its own claims, weighted by its own standing                                               |
| **Subject**    | The scored party. A sending domain or an IP holder. Self-attests DNS posture, vouches, files appeals                                                                           | A domain (the DKIM `d=` value) or an IP address | Claims about itself, all independently checkable                                           |
| **Aggregator** | Tails logs, runs the scoring policy, serves DNS, HTTPS, snapshots and the diff feed                                                                                            | Its service host names and DNSSEC-signed zone   | Nothing. Its output is arithmetic anyone can redo                                          |
| **Monitor**    | Verifies tree-head consistency across logs, gossips heads, spot-checks attestations, adjudicates challenge openings, recomputes scores, publishes `audit-finding` attestations | A domain, same as an observer                   | Its findings, which are machine-checkable, plus its confidentiality duties during openings |

A log MUST be content-neutral: it validates form and signatures and MUST NOT
accept or refuse an attestation based on whether it believes the claim.

An aggregator MUST be reproducible: given the same declared set of tree heads
and the same policy version, two aggregators MUST produce identical
`ScoreResult` output for the same subject, byte for byte after canonicalization.
An aggregator that cannot be reproduced is broken, not merely unpopular.

A monitor SHOULD NOT be operated by the same party as the log or aggregator it
watches, and an aggregator's default trust set MUST NOT count two monitors under
common control as two.

## 1.2 Subjects

A subject is a domain, an IP, or the pair. Domains are primary. Domain standing
survives an IP change, which is exactly the portability small senders lack
today; IP standing exists because a receiver has to decide something at connect
time, before any DKIM signature is available.

The scored domain identity is the exact DKIM `d=` domain (plan D3). Three
consequences follow, and all three are deliberate:

- From-header alignment is a posture signal, not the identity. An explorer MAY
  display an organizational-domain rollup; scoring MUST NOT use one.
- An ESP customer subdomain such as `d=customer.esp.example` earns standing
  separately from `esp.example`.
- An ESP's shared signing domain carries the ESP's collective behaviour. That is
  where control lives, so that is where accountability lands.

An IP subject is compared as text, never as a parsed address, because the
canonical bytes are what gets signed. Each address therefore has exactly one
admissible spelling: IPv6 in RFC 5952 presentation form (`2001:db8::1`, not
`2001:0DB8:0:0:0:0:0:1` and not `2001:db8:0:0:1::`), IPv4 in dotted-quad decimal
with no leading zeros. Producers MUST publish that form and verifiers MUST
reject any other, rather than normalizing it. Two spellings of one address would
otherwise be two subjects, splitting one sender's history in half at the
convenience of whoever wrote the record. Query input is the same exception it is
for domains (§1.3): an aggregator MAY normalize the address a caller asks about
before matching it.

IP evidence attaches to the `(IP, domain)` pair whenever DKIM is present, and
flows into the domain score from there, so a shared IP's other tenants stay on
their own pairs. Evidence with no domain presented is bare-IP evidence and MUST
be scored at /32 for IPv4 and /64 for IPv6. A `posture` attestation that
declares an owned range regroups that party's bare-IP evidence to the declared
range (plan D2).

## 1.3 Identifiers

- **Observer ID / monitor ID / subject domain.** A DNS domain in lowercase
  A-label form. The rule splits by role, because normalization and verification
  want opposite things. A verifier MUST reject an attestation carrying a
  non-lowercase or U-label domain rather than folding it, since the signature
  covers the bytes as written and folding would admit two spellings of one
  identity. A consumer MAY normalize its own query input, and an aggregator MAY
  normalize the domain a caller asks about, before matching it against the
  identities in the log: that is lookup ergonomics, and it never changes what
  was signed.
- **Log ID.** A stable, opaque, printable ASCII string chosen by the log
  operator, unique across the logs an aggregator trusts. It appears in every
  `LogEntryRef` and orders the deterministic merge in
  [06-scoring](06-scoring.md), so a log MUST NOT change its ID after publishing
  its first tree head.
- **Log entry coordinates.** The pair `(logId, index)`, with `index` the
  zero-based leaf position. Coordinates are permanent; a redaction event
  (see [11-governance](11-governance.md)) withholds a preimage but MUST NOT
  renumber or remove a leaf.

## 1.4 Federation, and why it is not one database

Federation appears in three separate places, each defusing a different capture
risk. Multiple logs, so no operator can silently drop or reorder evidence.
Multiple observers, so no receiver's view of the world dominates. Multiple
aggregators, so no one controls the number people actually read.

The specification is the product. Every running service is replaceable, and an
implementation that only works against one operator's endpoints is not
conformant.

## 1.5 Bootstrap allowlist and its sunset (plan §4.2)

Observer standing is defined by corroboration against other observers
([06 §6.4](06-scoring.md)), which is circular at genesis: the first
observers have nobody to be corroborated by. Phases 0 through 2 therefore run on
an explicit bootstrap allowlist of seed observers whose attestations carry
standing they have not yet earned.

The following rules make that an admitted crutch rather than hidden
centralization:

1. The allowlist MUST be published, in full, alongside the deployed policy
   version. A private allowlist is a conformance violation, not a configuration
   choice.
2. Every score whose explanation depends on an allowlisted observer's weight
   MUST say so in the `ExplanationGroup` for that evidence.
3. The allowlist MUST NOT grant score bonuses to the listed party as a subject.
   It affects the weight of what an observer says, never the standing of what
   the same operator sends.
4. The allowlist MUST sunset by Phase 3: from the first policy version published
   after the Phase 3 governance charter is ratified, observer weight MUST derive
   only from earned standing, and the allowlist mechanism MUST be removed from
   the policy rather than emptied and left in place.
5. Until it sunsets, each allowlist change MUST be published as a signed, dated
   operator notice alongside the policy version it applies to, so the editorial
   history is public and diffable. It is not an attestation: the kind set is
   closed at `v: 1` ([02 §2.1](02-attestations.md)) and none of the eleven kinds
   carries an allowlist edit. Logging allowlist changes as first-class
   attestations is a candidate for the next envelope version
   ([11 §11.5](11-governance.md)).

Contributing MUST NOT buy standing. Consuming is free and anonymous by design,
most receivers will free-ride, and the registry needs a contributing minority
rather than universal participation. Paying with data is barred on the same
constitutional ground as paying with money
([11-governance](11-governance.md)).
