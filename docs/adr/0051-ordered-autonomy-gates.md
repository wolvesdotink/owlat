# ADR-0051: Ordered restrict-only autonomy gates

## Status

Accepted.

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
