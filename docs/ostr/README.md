# OSTR

The Open Sender Trust Registry: a public, federated, cryptographically
transparent registry of how a domain or IP has behaved as an email sender.

Sender reputation today lives in private silos. Google Postmaster, Microsoft
SNDS, Validity SenderScore and a few dozen DNSBLs each keep their own list with
their own secret criteria, and a self-hosted sender cannot port standing between
them, see the evidence behind a listing, or contest one. OSTR replaces that with
signed evidence in an append-only log, plus an open scoring function anyone can
re-run to get the same answer.

The shape of it:

- **Observers** (receiving mail systems) publish signed attestations about mail
  they actually received: traffic and authentication counts, spam-report batches
  backed by DKIM evidence, trap hits, DKIM key observations.
- **Subjects** (sending domains) self-attest DNS posture, vouch for others, and
  appeal evidence they dispute. All on the public record.
- **Logs** sequence attestations into RFC 9162-style Merkle trees and publish
  signed tree heads.
- **Aggregators** run the open scoring policy and serve the answers over DNS,
  HTTPS, and signed snapshots.
- **Monitors** watch the logs for equivocation, adjudicate challenge samples,
  and publish machine-checkable findings.

A spam report only counts when it comes with cryptographic proof that the
accused domain actually sent the message, and no individual user's report ever
reaches the public record.

Working title only. The public name is chosen at launch and will not contain
"Owlat"; a registry named after one of its operators cannot claim neutrality.

## Where things are

|                  |                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specification    | [spec-v0.md](spec-v0.md), sections in [spec/](spec/)                                                                                                                       |
| Decision record  | [ADR-0058](../adr/0058-open-sender-trust-registry.md)                                                                                                                      |
| Design plan      | `TRUST_REGISTRY_PLAN_2026-08-20.html` at the repository root                                                                                                               |
| Core library     | `packages/ostr-core` (schema, JCS canonicalization, ed25519, Merkle primitives, scoring policy)                                                                            |
| Consumer library | `packages/ostr-client` (DNS lookup, snapshot and diff sync, observer re-weighting). Empty scaffold; filled in Phase 1, re-weighting in Phase 3                             |
| Observer library | `packages/ostr-observer` (evidence capture, key observations, windowed aggregation, batch commitments). Empty scaffold; filled in Phase 1                                  |
| Registry service | `apps/ostr-registry` (log, reference aggregator, DNS zone generation, HTTPS API, explorer). Empty scaffold; single-node log and aggregator in Phase 0, the rest in Phase 2 |

Every tunable of the scoring function lives in the `POLICY_V1` constants
exported from `@owlat/ostr-core/scoring`. Those constants are normative; the
spec describes the model and deliberately carries no numbers. The bounds that
sit outside the scoring function, such as retention windows and k-anonymity
floors, are deployment values at v1 and are listed with their status in
[06 §6.6](spec/06-scoring.md).

## Phase status

| Phase | Scope                                                                                                                                                              | Status          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| 0     | Written spec v0, `ostr-core` with golden-file determinism tests, single-node log and aggregator behind a dev flag                                                  | **In progress** |
| 1     | Private federation: observer and client wired into Owlat behind opt-in flags, a handful of real instances submitting, monitor-only challenge sampling              | Not started     |
| 2     | Public transparency: public log, at least two independent monitors, DNS zone with the `bl.`/`wl.` compatibility views, snapshots, pooled relay for small observers | Not started     |
| 3     | Federation and governance: second log operator, non-Owlat observers, vouching live, charter ratified, consumer re-weighting shipped                                | Not started     |
| 4     | Standardization: IETF draft for the attestation format and DNS query interface, outreach to other MTA projects                                                     | Not started     |

Phase 0 exits when two independent implementations of the scoring function
produce byte-identical explanations on a shared fixture corpus. One of them is
TypeScript, in this repository.
