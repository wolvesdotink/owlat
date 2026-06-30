# Webhook event modules — inbound adapters and outbound payload contracts

**Status:** accepted

## Context

Webhook handling smears across two boundaries — inbound (provider → Owlat)
and outbound (Owlat → customer) — and at each boundary the per-event
concept has no module.

### Inbound

Three HTTPS webhook handlers (`apps/api/convex/resendWebhook.ts`,
`mtaWebhook.ts`, `webhooks/channels.ts`) and the MTA SMTP bounce server
(`apps/mta/src/bounce/server.ts` + `bounce/classifier.ts` +
`bounce/parser.ts` + `bounce/fblProcessor.ts`) each implement the same
pipeline independently: verify signature → store raw payload for audit →
parse envelope → classify event kind → dispatch to a domain mutation.

The per-step drift:

- **Signature verification** is open-coded four times: Svix multi-sig
  base64 in `resendWebhook.ts`, single-sig hex over `${ts}.${body}` in
  `mtaWebhook.ts`, plus per-channel variants (Twilio/Meta/generic) in
  `webhooks/channels.ts`. `constantTimeEqual` exists in three near-
  identical copies. Each handler decides independently how to fetch its
  signing secret, how strict the timestamp window is, and what error
  response shape to return.
- **Hard/soft bounce classification** has two copies — `classifyResendBounce`
  inline in `resendWebhook.ts:48` (regex over a single string), and the
  full DSN/ARF classifier in `apps/mta/src/bounce/classifier.ts` (RFC 3464
  status codes). The MTA's classifier output is shipped to Convex's
  `mtaWebhook.ts` pre-classified, which then trusts the result; the
  Resend handler classifies on receipt. Adding an ISP variant means
  patching both.
- **Dispatch** is per-handler `if (payload.event === 'bounced')` /
  `if (payload.type === 'email.bounced')` chains that all end up calling
  the same `sendLifecycle.transitionByProviderMessageId`. Adding a fourth
  provider means cloning the whole pipeline.

`mtaWebhook.ts:235` already calls `getInboundChannelAdapter('mta').
parseInbound(payload)` from `@owlat/channels` for the
`inbound.received` case only. One adapter, no other call sites — a
hypothetical seam by LANGUAGE.md, sitting next to four un-adapted event
kinds in the same file.

### Outbound

ADR-0002 introduced `apps/api/convex/webhooks/events.ts` as the catalog
of subscribable event literals — that fixed literal drift across `webhookEventValidator`,
schema unions, and `listByEvent`/`create`/`update` mutation args.

What the catalog did not contract is the **payload shape per event**. The
fanout action validator still types `data` as `jsonPrimitiveRecord`
(`webhooks/delivery.ts:274`). Two unrelated drift sources remain open:

1. **Three inline event-literal unions** survived in `webhooks/delivery.ts`:
   `fireWebhookEvent` args (lines 263–272), `deliverWebhook` args
   (lines 331–340), and `webhookEventValidator` itself (lines 78–88 in
   `events.ts`). The first two never got migrated to the catalog. Adding
   a new event today is still a four-place change.
2. **Payload shapes have no schema** anywhere — they're documented in
   `docs/webhook-payloads.md` and constructed inline at every fire site.
   Misspelling `contactEmail` as `contact_email` at the assembly site
   ships silently to customers. Webhooks are public API; silent drift
   here is the most expensive class of bug we can ship.

### Shared framing

Both sides have the shape "an event of varying kind crosses a boundary
between Owlat and the outside world." The per-event concept has no module,
so per-event details (signature verification per provider; payload shape
per event; classification per provider) accumulate as ceremony at every
caller site. The deletion test concentrates: deleting the per-handler
verify/classify/dispatch logic at one site reveals the same code
re-implemented at the other sites.

## Decision

Two parallel module families sharing one vocabulary. The same wire
literal (`email.bounced`) names the inbound event kind, the lifecycle
transition's downstream emission, and the outbound customer event.

### Inbound: per-provider adapter + shared dispatcher

A per-provider **Inbound adapter** at
`apps/api/convex/webhooks/adapters/<provider>.ts` exports exactly two
operations:

```ts
verifySignature(req: Request): Promise<{ ok: true } | { ok: false; reason: string }>;
parseEvent(body: string): InboundDeliveryEvent;
```

The adapter owns provider-specific signature schemes (Svix multi-sig,
single-hex, Twilio base64-HMAC), per-provider timestamp tolerance, and
envelope-to-`InboundDeliveryEvent` translation including classification
(bounce hard/soft from a provider-shaped input). Adapters never read or
write the database and never call domain mutations.

`InboundDeliveryEvent` is the normalized discriminated union (declared in
`webhooks/types.ts`):

```ts
type InboundDeliveryEvent =
  | { kind: 'email.sent'; providerMessageId: string; at: number }
  | { kind: 'email.delivered'; providerMessageId: string; at: number }
  | { kind: 'email.bounced'; providerMessageId: string; at: number;
      bounceType: 'hard' | 'soft'; bounceMessage?: string }
  | { kind: 'email.complained'; providerMessageId: string; at: number }
  | { kind: 'email.opened'; providerMessageId: string; at: number;
      ip?: string; userAgent?: string }
  | { kind: 'email.clicked'; providerMessageId: string; at: number;
      link: string; ip?: string; userAgent?: string }
  | { kind: 'inbound.received'; normalized: NormalizedInboundMail }
  | { kind: 'internal.circuit_breaker_tripped'; message: string;
      bounceRate?: number }
  | { kind: 'internal.ip_event'; subkind: 'blocklisted' | 'delisted' |
      'warming_complete' | 'all_blocked'; ip?: string;
      blocklists?: string[]; severity?: 'info' | 'warning' | 'critical';
      message?: string };
```

The `email.*` kinds match the **Webhook event** wire literals exactly so
one word travels through inbound, lifecycle, and outbound without
translation. The `internal.*` kinds are never customer-fanned-out — they
exist only for ops dispatch.

The **Webhook dispatcher** is a typed table keyed by event kind:

```ts
type DispatchTable = {
  [K in InboundDeliveryEvent['kind']]: (
    ctx: ActionCtx,
    event: Extract<InboundDeliveryEvent, { kind: K }>
  ) => Promise<unknown>;
};
```

A missing entry is a compile error. Routes:

| Kind                                  | Downstream                                                      |
|---|---|
| `email.sent / delivered / opened / clicked` | `sendLifecycle.transitionByProviderMessageId` (Postbox-prefixed → `mail.outboundState.markSent` etc.) |
| `email.bounced / complained`          | `sendLifecycle.transitionByProviderMessageId` (Postbox-prefixed → `mail.outboundState.markBounced`) |
| `inbound.received`                    | `inbox.messages.receiveMessage`                                 |
| `internal.circuit_breaker_tripped`    | `organizationSettings.setAbuseStatusInternal`                   |
| `internal.ip_event`                   | `delivery.warmingSync.syncWarmingState` (+ severity-aware log) |

Postbox vs Send routing is owned by a small helper
`resolveProviderMessageId(id) → { kind: 'send'; ref: SendRef } |
{ kind: 'postbox'; mailMessageId }` consumed only by the dispatcher (and
later, by the workpool path — see follow-up).

The HTTP shell at `resendWebhook.ts` and `mtaWebhook.ts` collapses to a
thin pipeline:

```ts
export const handleResendWebhook = httpAction(async (ctx, request) =>
  runInboundPipeline(ctx, request, resendAdapter, 'resend')
);
```

`runInboundPipeline` (in `webhooks/pipeline.ts`) owns rate limiting,
audit-payload storage, the adapter calls, dispatch invocation, and HTTP
response shaping. Method check, JSON error responses, and the 503-when-
no-secret pattern live here once.

The MTA SMTP bounce server in `apps/mta/src/bounce/server.ts` is also an
Inbound delivery event producer — but its transport is SMTP not HTTPS,
so it constructs the union directly and ships pre-built events to the
MTA webhook. The bounce classification module
(`apps/mta/src/bounce/classifier.ts`) becomes the canonical classifier;
the Resend adapter calls into it (or a sibling shared classifier in
`@owlat/shared`) so the hard/soft heuristics live in one place.

### Outbound: per-event module + module-driven fanout

A per-event **Webhook event module** at
`apps/api/convex/webhooks/events/<literal>/index.ts` exports:

```ts
interface WebhookEventModule<TInput, TData> {
  readonly literal: string;
  readonly description: string;
  readonly isSubscribable: boolean;
  readonly schema: Validator<TData>; // Convex validator over the data payload
  build(input: TInput): TData;
}
```

`build` is pure — no `ctx`, no `await`. Callers (`sendLifecycle`,
`contacts/*` mutations, `topics/*` mutations) pre-resolve the domain
data they already have in hand and pass it in. The module owns the wire
shape contract and nothing else.

The ADR-0002 catalog at `webhooks/events.ts` becomes the module registry:

```ts
import { emailBounced } from './events/email.bounced';
import { emailDelivered } from './events/email.delivered';
// ...
export const WEBHOOK_EVENT_REGISTRY = {
  [emailBounced.literal]: emailBounced,
  [emailDelivered.literal]: emailDelivered,
  // ...
} as const satisfies Record<string, WebhookEventModule<unknown, unknown>>;
```

The two inline event-literal unions in `delivery.ts` (`fireWebhookEvent`
lines 263–272, `deliverWebhook` lines 331–340) and `webhookEventValidator`
in `events.ts` lines 78–88 all derive from the registry's keys via the
same single-cast pattern ADR-0002 already uses. Closes the ADR-0002 hole.

`fireWebhookEvent` and `deliverWebhook` collapse into one **Webhook event
fanout** path:

```ts
async function fanout<T extends keyof typeof WEBHOOK_EVENT_REGISTRY>(
  ctx: ActionCtx, literal: T, input: InputOf<T>
) {
  const module = WEBHOOK_EVENT_REGISTRY[literal];
  const data = module.build(input);
  // Convex validator catches drift even if a caller bypasses TS narrowing
  assertMatches(module.schema, data);
  // Existing subscription-lookup + per-webhook delivery scheduling
  return scheduleFanout(ctx, literal, data);
}
```

Schemas evolve **append-only**: only new optional fields. Non-additive
changes require a new event literal registered as a distinct catalog
entry (e.g. `email.bounced` and `email.bounced.v2` coexist; customers
subscribe per-literal). The existing `CURRENT_WEBHOOK_PAYLOAD_VERSION`
in `lib/constants.ts` stays as the envelope-level marker for the
`{ event, timestamp, data }` wrapper.

## Considered options

### Inbound: scope of the adapter

1. **Thick adapter — owns dispatch too.** Adapter signature becomes
   `handle(ctx, request) → Response`. HTTP shell is one line. Pushes
   provider concerns furthest from handler files but each adapter now
   knows about every domain mutation (sendLifecycle, mail.outboundState,
   inbox.messages, orgSettings) — the adapter's interface grows to mirror
   the dispatch table, defeating the deepening. Rejected.
2. **Per-event-kind module (no per-provider adapter).** Modules keyed by
   `event.kind`; each owns classification and dispatch; provider
   differences become per-adapter config inside. Conflates "what kind of
   event is this" (varies per provider) with "what do we do about it"
   (does not). Rejected.
3. **Thin adapter — verify + parse only** *(chosen)*. Smallest interface;
   HTTP shell owns rate limit / audit / dispatch / response; the
   dispatch table is shared across providers; the adapter is pure
   wire-shape translation. Two adapters (Resend + MTA) make the seam real
   per LANGUAGE.md.

### Outbound: scope of `build`

1. **Action-aware `build(ctx, input)`** that performs its own lookups
   (contact email, campaign name). Modules must live in `'use node'`
   runtime, can't be unit-tested without a Convex harness. Per-event
   lookup logic colocates with the contract — but callers already have
   the docs in hand at the call sites; lookups would be redundant work.
   Rejected.
2. **Hybrid `build(input, enrich?)`** with optional async resolver.
   Keeps modules pure; callers in actions can pass an enricher.
   Machinery for a problem we don't have. Rejected.
3. **Pure `build(input)`** *(chosen)*. Caller passes resolved data.
   Modules trivially testable, runtime-agnostic. Tiny coupling cost:
   callers must know what fields each event wants — but they already
   construct the payload inline today, so it's a re-localization, not
   new work.

### Module home

1. **Domain-local** (`delivery/events/sendBounced.ts`,
   `contacts/events/contactCreated.ts`). Colocates payload contract with
   emitter. Trade-off: public-API surface is physically scattered —
   "what events do you ship?" requires walking N folders. Rejected.
2. **Hybrid** (schema central, build domain-local). Two-file dance per
   event for no clear win. Rejected.
3. **Central** (`webhooks/events/<literal>/`) *(chosen)*. Mirrors
   ADR-0001's `email-renderer/src/blocks/<type>/` exactly. One folder =
   one wire event = one shape contract. The customer-facing surface is
   browsable in one directory.

### Naming symmetry

1. **Separate inbound kinds** (`bounced` inbound vs `email.bounced`
   outbound). Dispatch translates kind→event. Loses the single-vocabulary
   property; introduces a translation seam for no reason. Rejected.
2. **Hybrid** (same names where overlapping). Per-kind judgment calls;
   easy to drift. Rejected.
3. **Match outbound wire literals exactly** *(chosen)*. Inbound returns
   `{ kind: 'email.bounced', ... }`. Forces inbound-only events
   (`circuit_breaker_tripped`, `ip.*`, `inbound.received`) to either
   become subscribable wire events or live under `internal.*`. We chose
   `internal.*` for now — never customer-fanned-out, never appears in the
   subscribable catalog. `inbound.received` may graduate to subscribable
   later if customers ask for it.

### Versioning

1. **Per-event `version` field** with subscribe-time version selection.
   Adds routing knobs. Useful for non-additive change, overhead for the
   common case. Rejected.
2. **Defer**. The first breaking change becomes an emergency decision.
   Rejected.
3. **Additive-only contract, no version field** *(chosen)*. Schemas
   append-only; non-additive changes require a new event literal
   (`email.bounced.v2`). Simplest customer story — they never receive a
   breaking change unintentionally.

### Migration shape

1. **Workpool completion absorbed.** Treat `emailWorkerMutations.ts::
   onEmailComplete` as a third InboundDeliveryEvent producer (kind:
   `internal.workpool_completed`). Fully symmetric — every sendLifecycle
   caller goes through the same dispatch. Stretches "Inbound" past its
   real meaning (workpool completion is local code with no provider
   envelope) and absorbs candidate #5's broader orchestration cleanup
   into this ADR. Rejected.
2. **Combined ADR scope** *(chosen)*. Inbound and outbound share the
   framing and one vocabulary; a single ADR reads as one decision.
   Workpool path stays in `emailWorkerMutations.ts` as a direct
   sendLifecycle caller. The only thing extracted now is the small
   `resolveProviderMessageId` helper that both the dispatcher and the
   workpool path can consume — that closes the Postbox routing
   duplication without absorbing the broader candidate #5 work.

## Consequences

### Files that collapse / disappear

- `resendWebhook.ts` shrinks from 271 LOC to a one-line `runInboundPipeline`
  call. `verifySvixSignature`, `classifyResendBounce`, the inline
  `ResendWebhookPayload` type, and the duplicated `constantTimeEqual`
  all move into `webhooks/adapters/resend.ts`.
- `mtaWebhook.ts` shrinks from 339 LOC to the same one-liner. HMAC
  verification, the inline `MtaWebhookPayload`, the duplicated
  `constantTimeEqual`, the Postbox-prefix branches, and the
  per-event-kind switch all move out — the first two into
  `webhooks/adapters/mta.ts`, Postbox routing into
  `resolveProviderMessageId`, the dispatch into the shared dispatcher.
- `webhooks/delivery.ts` loses the two inline event-literal unions
  (`fireWebhookEvent` and `deliverWebhook` args become derived). The
  `fireWebhookEvent` and `deliverWebhook` actions collapse to one
  `fanout` action that goes through the module registry. The retry
  machinery (`deliverWebhookInternal`) is unaffected.
- The three copies of `constantTimeEqual` consolidate into one in
  `lib/security.ts` (or wherever the pipeline helper lives).
- The hard/soft bounce classifier deduplicates: one shared classifier
  in `@owlat/shared` (or `apps/mta/src/bounce/classifier.ts` re-exported);
  the Resend adapter calls into it on the receiving side, the MTA bounce
  server calls into it on the sending side.

### Files that grow

- `webhooks/adapters/resend.ts`, `webhooks/adapters/mta.ts` (new).
- `webhooks/events/<literal>/index.ts` × 8 subscribable events (new
  files; each ~30–60 LOC).
- `webhooks/dispatcher.ts`, `webhooks/pipeline.ts`,
  `webhooks/types.ts` (new shared infrastructure; ~200 LOC total).
- `webhooks/events.ts` becomes the module registry; the
  `WEBHOOK_EVENT_CATALOG` constant is derived from registry keys plus
  per-module metadata.

### Test surface

Co-located unit tests + thin integration smoke (chosen layout):

- `webhooks/adapters/__tests__/resend.test.ts`,
  `webhooks/adapters/__tests__/mta.test.ts` — signature verification
  (valid / replayed / tampered / wrong-window), envelope parsing per
  kind, classification edge cases.
- `webhooks/events/<literal>/__tests__/index.test.ts` — for each event,
  assert `build(input)` returns a value that satisfies `schema`.
- `webhooks/__tests__/dispatcher.test.ts` — each kind routes to the
  expected mutation with the expected args; the typed dispatch table is
  exhaustive by TypeScript.
- `__tests__/webhookFlow.integration.test.ts` — one end-to-end test per
  provider: raw HTTPS request → sendLifecycle row patched.

The previously-deleted `__tests__/resendWebhook.integration.test.ts`
does not come back; the unit tests + smoke replace it.

### Wire contract

- Every customer-visible payload now has a Convex validator on the
  Owlat side. Drift between docs (`docs/webhook-payloads.md`) and
  emitted payloads becomes a compile error (build returns the typed
  data) or a runtime assertion failure (fanout validates against
  schema). The docs page can be derived from the modules' `schema` +
  `description` in a future pass.
- Customer subscriptions are unchanged. Existing webhooks continue to
  receive the same `{ event, timestamp, data }` envelope; only the
  `data` shape acquires a contract.

### Vocabulary

CONTEXT.md gains Webhook events as a third domain section alongside
Email rendering and Send lifecycle. Six new terms — **Inbound delivery
event**, **Inbound adapter**, **Webhook dispatcher**, **Webhook event**,
**Webhook event module**, **Webhook event fanout** — pin the language
used in this ADR and in subsequent reviews.

## Follow-up work

1. **Candidate #5 — Outbound Send orchestration.** The workpool
   completion path (`emailWorkerMutations.ts::onEmailComplete`) still
   open-codes the same routing decisions as the dispatcher (Postbox
   vs Send, attachment cleanup, provider health tracking). The
   `resolveProviderMessageId` helper introduced here is the smallest
   shared piece; the broader cleanup (one orchestration module owning
   both workpool completion and provider feedback) is its own ADR.
2. **`inbound.received` as a subscribable Webhook event.** Today it's
   internal-dispatched only. Customers asking for "tell me when a
   contact replies" would graduate it to a wire literal with its own
   Webhook event module.
3. **`webhookEventValidator` derivation from the registry.** Same
   ADR-0002 single-cast pattern; mechanical once registry exists.
   Eliminates the last hand-maintained literal enumeration.
4. **Customer-visible event versioning.** If a non-additive payload
   change becomes necessary, the "new literal" mechanism is the first
   resort. A real version-field design only lands if that pattern
   produces too many literals to track.
5. **Generated `docs/webhook-payloads.md`.** Once every module owns a
   `schema` + `description` + `build`, the docs page is a derived
   artifact. Currently hand-maintained; a follow-up script can emit it.
