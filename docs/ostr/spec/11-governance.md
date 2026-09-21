# 11. Governance

[Index](../spec-v0.md) · prev: [10. Threat model](10-threat-model.md)

## 11.1 Constitutional rules

Five rules. Each is referenced normatively elsewhere in this specification, each
may be changed only by supermajority of the independent operators, and an
implementation that breaks one is not an OSTR implementation.

1. **Append-only.** Nothing is deleted or edited. Corrections are new
   attestations that supersede old ones, and the original stays visible
   ([02 §2.3.9](02-attestations.md)). The single exception is the redaction
   event in §11.3, which withholds a preimage and publishes the fact.
2. **Open, deterministic scoring.** The scoring function and its constants are
   public, versioned and reproducible. No private inputs, no operator
   discretion, no unpublished model ([06 §6.2](06-scoring.md)).
3. **No payment may affect standing.** Not for senders, not for observers, not
   for contributors of data. Access SLAs, rate limits and support may be sold.
   Standing, ordering, earlier data and score adjustments may not. Habeas and
   Goodmail both died of the inverse, and pay-with-data is barred on the same
   ground as pay-with-money.
4. **Appeal rights.** Every subject may contest specific attestations, publicly
   and on a bounded clock, at no cost ([07](07-appeals.md)).
5. **The privacy floor.** The hard rules in [09](09-privacy.md) hold in every
   deployment, regardless of local law, local appetite or local convenience.

## 11.2 Separation of spec and operations

- The specification lives in an open repository, and the target home is a
  neutral umbrella, a nonprofit association or foundation, once there are at
  least two non-Owlat operators. Long term, an IETF draft is the right
  destination; the ARF, DKIM and DMARC community is the right venue.
- The public name gets chosen at launch and MUST NOT contain "Owlat"
  ([index](../spec-v0.md)). A registry named after one of its operators cannot
  credibly claim neutrality, and neutrality is the product.
- Roles stay legally separable, because they carry different exposure. Logs are
  content-neutral conduits that validate form only. Aggregators publish
  recomputable arithmetic. Observers own their claims. An operator that merges
  the roles inherits all three postures at once.
- Language discipline is part of this. The registry publishes evidence of
  complaints, never "spammer". Tier labels are defined mechanically in the
  published policy, so an aggregator publishes arithmetic rather than
  characterization, and that distinction is the defense posture against
  defamation claims.
- Funding comes from infrastructure sponsorship and optional paid access SLAs.
  Never from standing.

## 11.3 The redaction event

"Never delete" cannot survive an injunction. Erasure requests under GDPR, and
court-ordered removals, will arrive, and the EU offers no Section 230 analogue:
DSA notice-and-action duties fall on whoever hosts the attestations. Improvising
under a court deadline is how transparency logs get quietly edited, so the
escape hatch is specified in advance.

A redaction event withholds a leaf's preimage from distribution while its hash
stays in the tree.

Requirements:

- The leaf hash MUST stay in the tree at its original index. Every inclusion and
  consistency proof MUST continue to verify, before and after
  ([05 §5.1](05-logs.md)).
- The redaction MUST itself be published, as a signed, dated notice from the
  operator that performed it: which leaf, which operator, under what authority,
  at what time. Attributable, not anonymous. It is not an attestation, because
  the kinds are a closed set at `v: 1` and none of them carries a redaction
  record ([02 §2.1](02-attestations.md)); a `redaction` kind is one of the
  candidates for the next envelope version (§11.5).
- Redaction MUST be reserved for legal compulsion and for privacy-floor
  violations that reached the log. It MUST NOT be used for disputed evidence.
  That is what appeals are for, and routing a dispute through redaction would be
  the quiet history-editing the whole design forbids.
- Scoring MUST treat a redacted leaf as excluded from that point forward, and
  every implementation MUST reach the same conclusion, so redaction does not
  break reproducibility.
- Aggregators MUST publish the list of redaction events they have honoured.

It is ugly and it should be rare. It is also the only version of legal
compliance that does not let a well-timed lawyer erase history without a trace.

## 11.4 Other design-relevant legal positions

- **Personal data.** Domains and IPs often are personal data. The claim is
  minimization, not absence: personal domains and sole traders mean the public
  record contains personal data, scored strictly in its sending role. The basis
  is legitimate interest, with strong precedent from DNSBL practice. No
  mailbox-user data enters the record at all. Appeals double as the Article 16
  rectification channel, and the bundle retention limits in
  [04 §4.2](04-evidence-and-reporting.md) are the storage-limitation story. EU
  based log and aggregator options are expected.
- **Forkability.** Snapshots are open and signed, the policy is open source, and
  the log is replicable. If governance is captured, the material to run a
  replacement is already distributed ([08 §8.3](08-query.md)). That is a real
  backstop and a weak plan, and [10 §10.1](10-threat-model.md) says so.

## 11.5 Changing this specification

- Changes to the constitutional rules in §11.1 require operator supermajority.
- Changes to wire formats, meaning the attestation envelope, the DNS key record
  and the DNS answer, require a version bump on the affected artifact and a
  migration window in which both versions are accepted.
- Changes to scoring follow the cadence, overlap and emergency-lane rules in
  [06 §6.2](06-scoring.md).
- Changes to the bootstrap allowlist are published operator notices until the
  allowlist sunsets in Phase 3 ([01 §1.5](01-terminology.md)).

Four governance events are published today as signed operator notices because
the attestation kinds are closed at `v: 1`: challenge openings
([04 §4.4](04-evidence-and-reporting.md)), allowlist changes
([01 §1.5](01-terminology.md)), emergency-lane justifications
([06 §6.2](06-scoring.md)) and redaction events (§11.3). The publication duty is
identical either way; what a notice lacks is inclusion in the tree, so a reader
verifies the operator's signature rather than a Merkle proof. Giving all four a
kind, and therefore a log position and a proof, is the first candidate on the
list for the next envelope version.
