# ADR-0058: The Open Sender Trust Registry

## Status

Accepted. Phase 0 of the design plan `TRUST_REGISTRY_PLAN_2026-08-20.html`;
the written specification is [docs/ostr/](../ostr/README.md).

What is accepted is the decision below: build the registry as an open,
federated, specified-first system rather than a private Owlat score, on the
architecture described here. The artifact is not frozen with it. The plan is
still a proposal, spec v0 is a draft that says of itself that it is not yet
ready for external implementers, and both are expected to change under review.
A change to the specification does not reopen this ADR; a change to the decision
supersedes it.

## Context

Whether an Owlat sender reaches the inbox is decided mostly by reputation
systems none of our users can read, contest, or carry with them.

- **The data is per-silo and unportable.** Gmail has Postmaster Tools, Microsoft
  has SNDS and JMRP, Validity sells SenderScore, and Spamhaus, Barracuda and
  SpamCop each keep their own list. Standing exists inside each silo and nowhere
  else. A sender who spent two years earning it at one receiver starts at zero
  at the next, and courts each gatekeeper separately.
- **The criteria are secret and the evidence is invisible.** A listing arrives
  with no attached facts, so a delisting request is an appeal to a party that
  never had to say what it saw. Some lists have historically shaded into
  pay-to-delist.
- **Low volume reads as no signal.** A self-hoster sending a few hundred
  authenticated messages a month is "unknown" everywhere, permanently, while
  volume buys grading on a curve. Anyone on a recycled IP inherits a stranger's
  history.
- **Spam reports carry no proof.** Nothing in the current pipelines demonstrates
  that the reported message was ever sent by the accused domain, so
  report-bombing works and a false positive is unfalsifiable.

The part that lands on us directly: Owlat's deliverability stack has an input it
cannot get. The ramp controller in ADR-0054 governs per-cell sending against
outcome signals we measure ourselves, and the one thing it cannot see is how
receivers actually rate our senders. For a hosted ESP that gap is filled by
Postmaster Tools. For a self-hosted instance there is nothing, and telling users
to go make a Google account to find out how their own mail server is doing is a
poor answer from a product whose premise is that you run your own mail.

Building a private Owlat-only reputation score would fix our instrumentation and
reproduce the disease: another silo, opaque from outside, worth nothing to a
sender the day they leave.

## Decision

Build an open registry, specified before it is implemented, that any receiver
can consume and any receiver can contribute to. Owlat is the reference
implementation and the bootstrap federation, and deliberately not the authority.

### The specification is the deliverable

`docs/ostr/spec-v0.md` and its numbered sections are normative: the attestation
envelope and all eleven kinds, RFC 8785 canonicalization and ed25519 signing,
`_ostr.<domain>` key discovery, DKIM evidence admissibility, log requirements,
the scoring model, appeals, the query interfaces, the privacy floor, the threat
model, and the constitutional rules.

Written first, and separately from the code, because federation is a claim about
what someone else can build. A second implementation that has to read our
TypeScript to learn the rules is not a federation, it is a port.

The working title is OSTR. The public name is chosen at launch and MUST NOT
contain "Owlat". A registry named after one of its operators cannot claim
neutrality, and neutrality is the entire product.

### The numbers live in code, in exactly one place

The specification carries the signal model. Which evidence exists, which
direction it moves a score, which bounds hold. It carries no weights, no
half-lives, no caps, no thresholds.

Those are the `POLICY_V1` constants in `@owlat/ostr-core/scoring`, and they are
normative for `ostr-policy-v1`. Phase 0's exit criterion is two independent
implementations producing byte-identical explanations on a shared corpus, and
that dies the moment a constant exists in prose and in code and the two drift.
Prose here is illustration, marked as such, and `POLICY_V1` wins every conflict.

### Four workspaces, split by who runs them

`packages/ostr-core` holds everything all sides must agree on: the schema, JCS
canonicalization, ed25519 signing and verification, the Merkle tree and proofs,
and the versioned scoring function. Zero third-party dependencies, node:crypto
only, pure and deterministic throughout. No `Date.now()` anywhere in scoring or
verification; the evaluation instant is an argument, because a function that
reads the clock cannot be golden-file tested and a score that is not
reproducible is just an opinion with extra steps.

`packages/ostr-client` is the consumer side: DNS lookup, snapshot and diff sync,
local cache, observer re-weighting. `packages/ostr-observer` is the contributor
side: evidence capture off the existing `packages/mail-auth` verdict path and
the existing junk action, key observations, windowed aggregation, k-anonymity
bucketing, batch commitment and submission. `apps/ostr-registry` is the service:
log, reference aggregator, DNS zone generation, HTTPS API, public explorer,
deployable standalone like the rest of the self-hostable stack.

The split follows deployment, not layering. A consumer ships the client and
nothing else; an observer opts into a package it can be talked out of again;
nobody has to run the registry to benefit from it.

### The log is ours, the interface is CT's

`apps/ostr-registry` embeds its own Merkle store rather than pulling in Trillian
or Rekor, behind an RFC 9162-shaped API: signed tree heads, inclusion and
consistency proofs, standard semantics (plan D1).

The interface is the commitment, not the storage engine. Any public-phase
operator may run Trillian behind the same endpoints, monitors cannot tell the
difference, and the choice stays per-operator. What we are not doing is
operating a Trillian deployment to store what is, at Phase 0 scale, an
append-only file with a hash tree over it.

### A report is inadmissible without proof

The rule that separates this from every FBL: a spam report counts only with the
DKIM evidence showing the accused domain signed the message. Report-bombing
becomes cryptographically infeasible instead of merely against the rules.

DKIM was built for transit-time authentication, so its edges are admissibility
rules rather than footnotes. Signatures carrying `l=` are inadmissible, they do
not bind appended content. RSA below 2048 bits is inadmissible. The signature
must cover `From`, `Date` and `Message-ID`.

The deeper problem is that keys leave DNS. An appeal sixty days after receipt
finds no key, or finds one that anybody could have forged with, and both are
fatal to challenge-time verification. So observers log `key-observation`
attestations the first time they verify with a `(domain, selector, key)`, and
challenges verify against the logged, timestamped, multi-observer key record
rather than live DNS. That is why key rotation stays free here, and why "stable
keys" is deliberately not a scoring signal: the alternative design tells senders
to rotate for replay resistance while quietly needing them not to.

Evidence bundles never become public and never reach the accused. Challenge
openings go to adjudicating monitors only, sampled, with the fact of every
access logged and the contents never. A sender that crafts per-recipient
`Message-ID`s and then appeals must not be able to read its reporters out of the
answer.

### Scoring is arithmetic, published in advance

The policy is a pure function over a deterministic merge of log entries, totally
ordered by `(logId, index)` against a declared set of tree heads. Same heads,
same version, byte-identical output including the explanation sentences. Every
answer carries its policy version and its as-of head set, so a consumer is
caching an aggregator's arithmetic rather than trusting its judgment.

Versions ship quarterly at most, with a 60-day dual-serving overlap, plus one
emergency lane for actively exploited scoring bugs: shortened overlap,
supermajority of log operators, justification published, signed and dated,
before it takes effect. Without the lane a live exploit survives up to a
quarter. With an unpublished lane, "emergency" is how the scoring function gets
rewritten overnight by whoever is holding it.

## Consequences

- Inbound gains an OSTR tier as one more weighted verdict input beside SPF,
  DKIM, DMARC, ClamAV and spam scoring. Never a hard gate by default. That half
  is what this decision ships.
- The outbound half is the design's answer to the Postmaster-Tools-shaped hole,
  and it is still on paper. An instance will be able to watch its own domains'
  public standing and read the explanation behind it, feeding the deliverability
  stack the input it has never had. Nothing in this change wires that up: the
  aggregator already answers for any subject, so what is missing is the
  deliverability side asking about itself and acting on the answer.
- Even Phase 0 to 1 alone, a private Owlat-only federation, is worth shipping
  for the inbound input by itself. Nothing before Phase 2 requires anyone
  outside Owlat to care.
- **The bootstrap allowlist is centralization, on a timer.** Observer standing
  is defined by corroboration against other observers, which is circular at
  genesis, so Phases 0 through 2 run on a published list of seed observers whose
  weight is editorial. The spec requires it to be public, requires every score
  that depends on it to say so, forbids it from granting the listed operator any
  benefit as a sender, and requires it to be removed from the policy by Phase 3.
  It is a trust anchor we are naming as one. A bootstrap anchor presented as
  emergent consensus would be exactly the hidden centralization this replaces.
- **Small instances cannot contribute safely yet.** For a single-mailbox
  observer, the observer identity is the user identity: attesting "one report
  about X" tells X who reported. Widening the window does not fix it, and
  neither does bucketing. Observer mode therefore ships off by default and
  refuses below a mailbox-count threshold, so the population most invested in
  this registry is the population that cannot yet feed it. The pooled
  submission relay in Phase 2 (plan D6) is the intended fix; until it exists,
  small instances consume and do not contribute.
- **k-anonymity costs precision.** Small observers' evidence lands in coarse
  buckets and moves scores slowly. Batch commitments hide their contents by
  design, so cross-observer duplicate detection at scoring time does not exist
  at all; duplicates surface only in challenge openings, and per-observer caps
  are what bound an unchallenged replay campaign.
- **List traffic is under-measured.** Forwarding usually preserves DKIM, so
  evidence still attributes to the true signer. Mailing lists that rewrite
  content break the signature, and that traffic falls back to the weaker IP
  path. ARC only helps where the receiver already trusts the intermediary, which
  is a trust decision OSTR cannot make for it. A list-heavy small sender stays
  under-measured, and that is the case most likely to look unfair.
- Append-only means no quiet corrections. A retraction supersedes; the original
  stays visible. The one exception, the redaction event for legal compulsion,
  keeps the leaf hash in the tree and publishes the redaction itself, so proofs
  keep verifying and history-editing stays impossible to do silently.
- No payment may affect standing, for senders, observers or contributors of
  data. Access SLAs and rate limits are sellable; standing is not. Habeas and
  Goodmail both died of the inverse, and it is a constitutional rule here rather
  than a policy we could revisit under revenue pressure.
