# ADR-0043 — execution plan for ADR-0003 (webhook event modules)

> Companion execution plan for [ADR-0003](./0003-webhook-event-modules.md).
> Renumbered from `0003-execution-plan.md` to its own unique ADR number so the
> `000X` prefix is unambiguous (one document per number).

Phased migration for the webhook event modules ADR. Each phase is one
shippable PR. Existing tests pass at every phase boundary; behavior is
unchanged until the phase that explicitly migrates a wire path.

## Order rationale

**Inbound before outbound.** Inbound has the bigger immediate code-deletion
win (four copies of verify-parse-classify-dispatch ceremony) and zero
customer-visible blast radius — it's internal infrastructure. The
InboundDeliveryEvent vocabulary it forces into existence also informs
outbound (the `email.bounced` kind name reuses the wire literal).

**Resend adapter before MTA adapter.** Resend has fewer event kinds, no
Postbox routing, and the simplest dispatch (every kind is `email.*` →
`sendLifecycle`). MTA is more invasive (Postbox `pb-` branch, `internal.*`
events, `inbound.received` routing).

**Outbound module registry built up incrementally.** One event module
first (`email.bounced` — most-emitted, biggest test surface), prove the
pattern, then remaining events in small batches. The fanout collapse
comes after every event has a module — never half-migrated.

**Workpool path (candidate #5) explicitly out of scope.** The
`resolveProviderMessageId` helper is the only shared piece introduced
here. Broader orchestration cleanup is a separate future ADR.

---

## Phase 1 — Foundation (no behavior change)

**Changes**
- `webhooks/types.ts` — `InboundDeliveryEvent` union, `NormalizedInboundMail`,
  `WebhookEventModule<TInput, TData>` interface.
- `webhooks/security.ts` — consolidated `constantTimeEqual` (the three
  copies in `resendWebhook.ts`, `mtaWebhook.ts`, `webhooks/channels.ts`
  collapse here in phase 8; this phase only introduces the new home).
- `webhooks/dispatcher.ts` — typed dispatch-table interface
  `{ [K in InboundDeliveryEvent['kind']]: Handler<K> }`, registration
  helper, empty default implementation (no handlers wired yet).
- `webhooks/pipeline.ts` — `runInboundPipeline(ctx, request, adapter, source)`
  skeleton owning rate limit + audit storage + adapter.verify +
  adapter.parse + dispatcher.dispatch + HTTP response shaping.
- `delivery/resolveProviderMessageId.ts` — `{ kind: 'send'; ref: SendRef }
  | { kind: 'postbox'; mailMessageId: Id<'mailMessages'> }`.

**Tests**
- `delivery/__tests__/resolveProviderMessageId.test.ts` — pb-prefixed,
  non-prefixed, malformed.
- `webhooks/__tests__/dispatcher.test.ts` — type-only assertion that
  dispatch table is exhaustive once handlers are wired.

**Done when** — new files compile, unit tests pass, `resendWebhook.ts` /
`mtaWebhook.ts` untouched.

---

## Phase 2 — Resend adapter migration

**Changes**
- `webhooks/adapters/resend.ts` — `verifySignature` (moves Svix
  multi-sig + base64 + timestamp logic from `resendWebhook.ts:74–136`),
  `parseEvent` (returns InboundDeliveryEvent for `sent | delivered |
  bounced | complained | opened | clicked`).
- `resendWebhook.ts` shrinks to:
  `export const handleResendWebhook = httpAction((ctx, req) =>
    runInboundPipeline(ctx, req, resendAdapter, 'resend'));`
- `webhooks/dispatcher.ts` gains entries for the 6 `email.*` kinds,
  routing to `sendLifecycle.transitionByProviderMessageId` (Postbox
  routing via `resolveProviderMessageId`).
- `classifyResendBounce` moves into the adapter inline. Shared
  classifier consolidation is phase 4.

**Tests**
- `webhooks/adapters/__tests__/resend.test.ts` — sig verify (valid /
  invalid / replayed / wrong-window / missing-secret), envelope parsing
  per kind (well-formed + malformed), classifier edge cases.
- `__tests__/webhookFlow.integration.test.ts` — one Resend end-to-end:
  raw HTTPS request → `emailSends` row status patched.

**Removed** — `verifySvixSignature`, `ResendWebhookPayload` inline type,
duplicated `constantTimeEqual`, per-event-kind switch in handler.

**Done when** — Resend webhook processes events with byte-identical
side effects to before. Smoke covers bounce + complaint at minimum.

**Risk** — Wire compatibility: any uncovered corner case in Svix sig
verification fails webhooks silently. Mitigation: enable adapter
behind a `RESEND_WEBHOOK_USE_ADAPTER=true` env flag for one deploy
window; fall back to old path otherwise. Drop the flag after one week
clean.

---

## Phase 3 — MTA adapter migration

**Changes**
- `webhooks/adapters/mta.ts` — `verifySignature` (hex HMAC over
  `${ts}.${body}`), `parseEvent` returning all 9 MTA-side
  InboundDeliveryEvent kinds including `internal.*` and
  `inbound.received` (the latter calls
  `getInboundChannelAdapter('mta').parseInbound` — the existing
  `@owlat/channels` parser stays put, the adapter is a thin wrapper).
- `mtaWebhook.ts` shrinks to the same one-liner as `resendWebhook.ts`.
- `webhooks/dispatcher.ts` gains entries for `inbound.received`,
  `internal.circuit_breaker_tripped`, `internal.ip_event`. Postbox
  routing in the `email.*` handlers uses `resolveProviderMessageId`.

**Tests**
- `webhooks/adapters/__tests__/mta.test.ts` — sig verify, parse per
  kind, Postbox-prefix detection routed correctly downstream.
- Extend `__tests__/webhookFlow.integration.test.ts` with one MTA
  end-to-end per kind family (email-status, inbound, internal).

**Removed** — `MtaWebhookPayload` inline type, duplicated
`constantTimeEqual`, per-event-kind switch in handler, Postbox-prefix
branches inline in handler.

**Done when** — every MTA event kind that worked before still works,
and the dispatcher (not the handler) owns the routing decisions.

**Risk** — Same as phase 2; same env-flag mitigation
(`MTA_WEBHOOK_USE_ADAPTER=true`).

---

## Phase 4 — Shared bounce classifier *(optional, can defer)*

**Changes**
- Promote hard/soft classifier to `@owlat/shared/bounce/classifier.ts`
  (or `packages/email-scanner` if that's a better home — defer that
  call until inspection).
- Resend adapter imports from shared.
- `apps/mta/src/bounce/classifier.ts` either re-exports from shared
  or moves entirely.

**Tests** — Existing classifier tests follow the file.

**Done when** — one place to add a new ISP bounce pattern.

**Defer if** — the Resend heuristic (regex over a single string) and
the MTA classifier (RFC 3464 status codes) end up with too little
overlap to share without ceremony. In that case, document the
non-share in this plan and close phase 4 as won't-do.

---

## Phase 5 — Outbound module registry foundation

**Changes**
- `webhooks/events/email.bounced/index.ts` — first WebhookEventModule:
  literal, description, isSubscribable, schema (Convex validator over
  the documented `email.bounced` payload), pure `build(input) → data`.
- `webhooks/events/registry.ts` — `WEBHOOK_EVENT_REGISTRY` map with
  the one entry. Hand-maintained alongside the old catalog in
  `events.ts` until phase 6 completes.
- Old fanout path in `webhooks/delivery.ts` continues to work for all
  events — `email.bounced` callers can opt in to going through the
  module for parity testing.

**Tests**
- `webhooks/events/email.bounced/__tests__/index.test.ts` — `build(input)`
  returns a value that validates against `schema`; example payload
  matches `docs/webhook-payloads.md`.

**Done when** — registry pattern proven on one event without
behavior change.

---

## Phase 6 — Remaining event modules

One PR per ~2-3 events. Each PR adds N modules + registry entries +
co-located tests. Ordered by emission frequency to surface bugs early:

- PR A: `email.sent`, `email.delivered`
- PR B: `email.opened`, `email.clicked`
- PR C: `email.complained`
- PR D: `contact.created`, `topic.unsubscribed`
- PR E: `test`

**Done when** — all 9 events have modules; registry has every entry.

---

## Phase 7 — Fanout collapse + caller migration

**Changes**
- New `webhooks/fanout.ts` exporting `fanout(ctx, literal, input)`
  that looks up the module, calls `build`, validates against
  `schema`, schedules per-webhook delivery via the existing
  `deliverWebhookInternal` (unchanged).
- `fireWebhookEvent` and `deliverWebhook` in `delivery.ts` become
  thin aliases that delegate to `fanout` (preserves existing internal
  API surface during migration).
- Inline event-literal unions in `delivery.ts:263–272` and `:331–340`
  derive from `WEBHOOK_EVENT_REGISTRY` keys via the ADR-0002 single-cast
  pattern.
- `webhookEventValidator` and `subscribableWebhookEventValidator` in
  `events.ts:78–100` derive from the registry.
- Callers migrate to pass typed `input` instead of pre-built `data`:
  `sendLifecycle.transition` (every state edge), `contacts.create`,
  `topics/subscriptions` mutations. One callsite at a time, each in a
  small PR or a single coordinated PR.

**Tests**
- Integration smoke per event: payload received by a test
  subscriber endpoint is byte-identical to the pre-migration payload
  (or strictly additive). Run against `webhookFlow.integration.test.ts`.

**Done when** — every fanout path goes through `module.build`;
`fireWebhookEvent` / `deliverWebhook` are thin aliases.

**Risk** — Customer-visible. Schema validation might catch existing
payload bugs and fail webhooks that previously shipped malformed
data. Mitigation: ship schemas in *shadow mode* first (log mismatches
without failing) for one deploy window. Enforce in a follow-up PR
after the log is clean.

---

## Phase 8 — Cleanup + drift verification

**Changes**
- Delete `fireWebhookEvent` and `deliverWebhook` aliases; update
  callers to call `fanout` directly.
- Delete duplicated `constantTimeEqual` from `webhooks/channels.ts`
  (the last copy — Resend + MTA removed in phases 2/3).
- Delete `classifyResendBounce` if not removed in phase 4.
- Verify `docs/webhook-payloads.md` matches every module's `schema`;
  either hand-correct or generate from modules (follow-up #5 in ADR).
- Remove feature flags introduced in phases 2/3.

**Tests** — Full test suite green; no dead-code warnings from `tsc`.

**Done when** — zero remnants of the old per-handler ceremony; one
path for fanout; docs match schemas.

---

## Phase summary

| Phase | What | Wire-visible risk |
|---|---|---|
| 1 | Foundation types + helpers | None |
| 2 | Resend adapter | Low (feature-flagged) |
| 3 | MTA adapter | Low (feature-flagged) |
| 4 | Shared classifier | None (optional) |
| 5 | First outbound module | None (parallel path) |
| 6 | Remaining outbound modules | None (parallel path) |
| 7 | Fanout collapse + caller migration | **Medium** (shadow-mode first) |
| 8 | Cleanup + flag removal | None |

Estimated 8 PRs (or 12 if phase 6 splits PRs A–E and phase 7 splits
fanout from caller migration).

## Verification checkpoints

- After phase 3: every existing webhook integration test passes;
  feature-flag toggled both ways behaves identically.
- After phase 6: registry maps all 9 events; no event escapes the
  module path when fanout is forced through.
- After phase 7 (shadow mode): zero schema-mismatch logs for one
  week of production traffic.
- After phase 8: `rg "fireWebhookEvent|deliverWebhook"` returns no
  hits outside aliases; `rg "v\\.literal\\('email\\."` only inside
  registry/modules.
