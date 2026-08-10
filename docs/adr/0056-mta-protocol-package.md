# ADR-0056: The Convex↔MTA wire package

## Status

Accepted.

## Context

Convex and the MTA hold four conversations, and every one of them was declared
twice.

- **The send intake.** A private `interface SendRequest` in
  `apps/mta/src/routes/send.ts` faced four unannotated object literals in
  Convex: the dispatch adapter (`lib/sendProviders/mta/index.ts`), the Postbox
  send (`mail/outbound.ts`), and the mailbox forward and vacation auto-reply
  (`mail/deliveryHooks.ts`). Nothing but editing discipline held them together.
- **The routing decision.** The MTA emitted its answers as JSON literals;
  Convex re-declared the accept-list, the reason union AND a hand-mirrored
  `MTA_DEFER_REASON_ORIGIN` table beside the reader. That table decides whether
  a defer counts against a ramp cell's `governed`-deferral budget, so a reason
  added on one side and not the other either halts a cell for a fortnight over
  our own Redis outage, or stops counting a real refusal.
- **The IP-reputation snapshot.** `delivery/warmingSync.ts` parsed a shape
  `apps/mta/src/routes/ipReputation.ts` serialised, with no declaration between
  them.
- **The webhook events.** Two separate declarations —
  `packages/shared/src/mtaWebhookEvent.ts` and
  `apps/mta/src/webhookEventTypes.ts` — of one event union, one of them the
  ingress guard Convex fails events closed with.

Every one of these fails QUIETLY. A renamed field does not throw: it arrives
`undefined`, and the far end takes the branch for "the producer did not send
this", which is almost always the permissive or the deferring one.

## Decision

### One package, imported by both ends

`packages/mta-protocol` owns all four conversations, one declaration each
(`send.ts`, `routingDecision.ts`, `ipReputation.ts`, `webhookEvent.ts` +
`webhookEventShape.ts`). Types and pure validators only — no I/O.

Both ends are typed against it, PRODUCERS INCLUDED. That is the part that
matters: typing only the readers would have left every drift silent in exactly
the direction it already was. The MTA's handlers answer through `accepted()` /
`refuse()` helpers taking `MtaSendAccepted` / `MtaSendRefused`; Convex's four
send producers and its decision producer are annotated against
`MtaSendRequest` / `MtaSendRequestDraft` and `MtaRoutingDecisionRequest`.

The hand-mirrored `MTA_DEFER_REASON_ORIGIN` table is deleted. The one that
remains is both the type's source and the accept-list Convex validates an answer
against, so a reason cannot be added without an origin beside it, and a reason
the reader has not learned falls through to the unrecognised-answer path — safe,
and never silent.

This does NOT merge the two routing brains. Convex's governance and the MTA's
breakers/pools/leases stay separate; the package makes their conversation
impossible to drift, which is a different and much cheaper claim.

### One dependency, and it runs one way

D7 asked for a zero-dependency leaf. The shipped package declares exactly one
dependency, `@owlat/shared`, and that is deliberate.

The wire is STATED IN TERMS OF the shared vocabularies: `DeliveryDomain`,
`GovernedRoutingContext`, `GovernedIpPool`/`GovernedMessageType`, the
destination-provider taxonomy D8 gives exactly one declaration, and the IP
readiness verdicts the reputation snapshot carries. A package that re-declared
any of them to buy literal zero-dependency status would have traded one
duplication for a worse one — a second spelling of the vocabulary the FIRST
duplication was measured against.

What actually had to be preserved is the LEAF property, and that is a statement
about the edges, not the count: apps import this package, `packages/` does not.
Nothing enforces that on its own — the `@owlat/shared` direction would be a
package cycle that `bun install`, knip, `tsc` and `check-build-graph.ts` all
accept in silence, and any other `packages/` importer would not even cycle, so
nothing in CI would notice at all. So it is asserted directly, over every
workspace manifest and every `packages/` source file, in
`scripts/check-cross-package-imports.sh` on every `bun run lint`.

Runtime imports inside the package take `@owlat/shared`'s SUBPATHS, never its
barrel: the barrel re-exports modules that pull `tldts` (~1MB of public-suffix
data), and the Convex bundle would carry it for the sake of one guard.

So read D7's "zero-dependency leaf" as "leaf": apps import this package,
`packages/` does not, and it depends on `@owlat/shared` alone. That is the
accepted trade, not drift — a manifest with a second dependency, or any
`packages/` importer, is still a review failure and a lint failure.

### Frozen bytes, in one place both apps read

The named risk of this extraction is that TypeScript narrowing silently
re-shapes what is serialised. Types cannot be tested, so
`packages/mta-protocol/src/wireFixtures.ts` holds the wire as STRINGS — key
order included — and both apps' suites drive their SHIPPED code against the same
module.

It lives in `src/`, not `__tests__/`, for one reason: it is the only place both
apps can import ONE copy from. A fixture each suite kept its own copy of would
drift with the code it was meant to catch, and the two ends would agree with
themselves while disagreeing with each other.

The cost of that placement is a public `./wireFixtures` subpath, which resolves
from a shipped handler as happily as from a suite and which knip reads as an
entry, exempting everything it exports from the dead-code ratchet. So "test-only"
is asserted too, in the same `scripts/check-cross-package-imports.sh` pass: the
specifier is a lint failure in any file outside a `__tests__/` folder.

Each fixture is `satisfies`-checked against its declaration, so a rename fails
`tsc` before a suite runs; the decision fixtures are additionally keyed
`Record<…Reason, string>`, so the union cannot grow a member nobody wrote bytes
for.

## Consequences

- A field renamed on either end stops compiling on both. The three Postbox-only
  fields — `sealedMimeBase64`, `amp`, `allowedFromAddresses` — had no typed
  producer at all before this, and they are the ones whose silent failure was
  worst: dropped ciphertext, a lost AMP part, and a 403 on every
  personal-mailbox send, forward and vacation reply.
- `packages/shared/src/mtaWebhookEvent.ts` is deleted.
  `apps/mta/src/webhookEventTypes.ts` keeps only what is genuinely local to the
  producer — the three nested blobs the MTA builds and Convex re-parses
  (`inboundPayload`, `mailboxPayload`, `routingReentry`), bound to this
  service's own parsed types through the wire's `MtaWebhookPayloads` parameter.
- Adding a `packages/` consumer of this package is a lint failure, on purpose.
  If one is ever genuinely wanted, the decision to stop being a leaf gets made
  and recorded rather than merged by accident.
