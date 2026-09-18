# ADR-0051: Ordered restrict-only autonomy gates

## Status

Accepted. **Amended 2026-09-17** by [ADR-0060](./0060-decision-plane.md) — see
[Amendment — where a calibrated probability goes instead](#amendment--where-a-calibrated-probability-goes-instead-2026-09-17)
at the end of this document. The decision below is unchanged.

## Context

Route-time auto-approval already depends on a deliberately ordered set of
controls. Some failures are fail-closed while two historical configuration
reads are fail-soft. A plugin policy check must be able to withhold unattended
sending without becoming an approval source, moving a core control, or changing
the behavior of an installation with no configured gates.

The send itself is performed later by lifecycle effects. Re-running extensible
code at final dispatch would create a second policy boundary with different
state and retry semantics; the existing reference monitor remains responsible
for that boundary.

## Decision

The route step owns one immutable sequence. The circuit-breaker prerequisite
runs before autonomy evaluation. Only when an autonomy tier would approve do
the final gates run in this exact order:

1. message exists
2. spend budget
3. working hours
4. abandoned clarification
5. complaint or urgent classification
6. inbound guard availability
7. recipient lock
8. outbound injection scan
9. outbound DLP and credential scan
10. handling rules
11. bundled plugin autonomy gates in generated catalog order

Plugins append after every core gate. Their descriptors have no `before`,
`replace`, or `skip` mechanism. Tier-2 daily-cap charging remains after this
sequence, so an objection does not consume an auto-send slot. The legacy
working-hours configuration-read and handling-rules-read exceptions remain
fail-soft independently; no plugin error inherits that behavior.

### Restrict-only contract

The public capability is `send:gate`. A module returns exactly
`{ outcome: 'no-objection' }` or
`{ outcome: 'objection', reason: string }`. There is no approval result. The
host applies its restrict-only composition primitive, rejects accessors and
extra fields, bounds and scrubs objection text, and never places plugin text in
audit metadata.

Codegen emits a deterministic data-only catalog and a separate Node module
registry. An empty catalog performs no query, authorization, or audit work and
preserves prior routing behavior exactly.

### Runtime boundary

Immediately before each sequential invocation, the host revalidates singleton
scope, exact catalog ownership, bundled registration, enabled flag,
`send:gate` declaration and grant, and required environment presence. Missing,
duplicate, stale, disabled, revoked, or environment-incomplete catalogued gates
object to auto-send. So do authorization uncertainty, exceptions, malformed
results, and timeout.

Modules receive only a copied, frozen, size-bounded mail projection and an
`AbortSignal`; they never receive a Convex context, identifiers, credentials,
or another host service. The manifest timeout is strictly validated and the
runtime clamps it to the host maximum. Timeout aborts the signal and drains
late rejection; late work has no host capability it can invoke.

A completed outcome must be audited before a no-objection is accepted. If that
audit fails, routing fails closed. Audit uses only system attribution and fixed
operation/outcome/reason codes. Objection reasons, mail content, thrown errors,
and caller text are excluded.

## Consequences

- Plugins can only reduce autonomous sending; they cannot manufacture approval.
- Core safety order and the two named compatibility exceptions remain testable
  without plugin code.
- Catalog drift and runtime uncertainty route mail to human review.
- The route-time decision runs once; dispatch-time enforcement remains with the
  existing reference monitor.
- Connected HTTP gates remain deferred until the signed synchronous-hook host
  exists.

## Amendment — where a calibrated probability goes instead (2026-09-17)

Amends nothing in the sequence, the restrict-only contract or the runtime
boundary above. It adds one rule about a kind of input that did not exist when
this ADR was written: a **calibrated probability** from the decision plane
([ADR-0060](./0060-decision-plane.md)). The gates stay restrict-only, the
eleven-step order stands, and no gate ships on that branch — this is written
down before the first call site migrates, not after.

It exists because an earlier draft of the decision-plane plan got it wrong. That
draft proposed a three-way router in the gate registry that would *unlock*
auto-send above a probability threshold. That is not a gate. The registry has no
approval result to return (`{ outcome: 'no-objection' } | { outcome: 'objection',
reason }`), and the host composes those with a restrict-only primitive, so the
strongest thing a member can do is decline to object. A router placed there
could only ever be a no-op in the direction it was reaching for — or, if the
composition were changed to accommodate it, would turn every plugin-supplied
gate into a potential approval source. The amendment is here so the next person
reaching for the registry finds this note first.

**1. A probability does not become a gate.** No decision answer may widen an
outcome. It may restrict one.

**2. It belongs where a score already decides.**
`apps/api/convex/agent/steps/route/index.ts:142` computes
`resolveAutoApproveScore(input.draftQuality)` once and that value — not the
classifier's confidence — is what the tiers compare: it is passed as
`confidence` to `internal.autonomy.checkPermissionInternal` at line 172 (tier 2)
and compared against `cfg.confidenceThreshold ?? 0.8` at line 218 (tier 3).
`draftQuality` is produced by `runDraftSelfCheck` in
`agent/shared/draftService.ts`, a text model rating its own draft, and
`resolveAutoApproveScore` (line 85) already returns `0` when that self-check is
missing or failed. Replacing that number with a calibrated one improves the
input the gates already read and touches no gate structure. It is fail-soft in
the same direction: an uncalibrated or absent answer must resolve to a score
that clears nothing.

**3. The registry may only gain a block-only member.** The one gate the decision
plane is entitled to is an `uncalibrated_decision` gate: it objects when an
answer a routing decision depended on came back uncalibrated, or from a
different provider than the one now configured. It objects or it does not; it
never approves, which is the only shape this registry has.

**4. The deterministic controls stay, and stay ORed.** A probability is a second
opinion beside the injection regexes and the DLP scan, never a replacement for
one. The threat model is the reason: the state a decision is answered over is an
email a stranger wrote, and the vendor documents that instructions inside that
state can move an answer.

### Consequences

- Nothing in this ADR's sequence, catalog order or runtime revalidation changes,
  and an installation with no decision plane configured routes exactly as before.
- The first decision-plane migration is a change to one score, reviewable on its
  own, rather than a change to the structure every auto-send passes through.
- A future proposal to route auto-send on a probability is a proposal to reopen
  the restrict-only contract, and has to say so in those words.
