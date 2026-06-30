# Channel inbound adapters — extending the Inbound event family to non-email transports

**Status:** accepted

## Context

ADR-0003 deepened the email-side inbound webhooks (Resend HTTPS, MTA HTTPS,
MTA SMTP) into per-provider **Inbound adapters** + a shared
`runInboundPipeline` + a typed **Webhook dispatcher** over a closed
`InboundDeliveryEvent` union.

The non-email side — SMS (Twilio), WhatsApp (Meta), generic shared-secret
webhooks — was left out. `apps/api/convex/webhooks/channels.ts` (390 LOC)
still open-codes three sibling `httpAction` handlers, each implementing
the same pipeline independently:

- **Signature verification** — three open-coded variants (Twilio's HMAC-SHA1
  over a canonical URL+sorted-params string; Meta's HMAC-SHA256 with
  `sha256=` prefix strip; Generic shared-secret in either of two headers).
  Each handler decides independently how to fetch its secret and how to
  fail-closed when missing.
- **Payload parsing** — Twilio gives URL-encoded form params; Meta gives
  deeply-nested `entry/changes/value/messages` JSON; Generic accepts a
  loose `{from ?? sender ?? 'webhook'}` envelope.
- **Dispatch** — all three terminate at one internal mutation
  `webhooks.channels.processInboundChannel({channel, from, content,
  externalMessageId, metadata})`.

This is precisely the shape ADR-0003 fixed for the email side. The
deletion test from LANGUAGE.md concentrates: deleting the per-handler
verify/parse/dispatch logic at one site reveals the same code
re-implemented at the other sites — and again on the email side, which
*already has* the fix. The codebase has two parallel inbound architectures
because the channel side was scoped out of ADR-0003.

Two adjacent forces shape the channel deepening differently from email:

1. **One downstream consumer.** Every channel event terminates at the
   same internal mutation. Where email has six `email.*` kinds fanning to
   distinct lifecycle transitions, channels have one. The dispatcher gets
   one entry, not three or four.

2. **Meta's GET verification challenge.** Meta subscriptions are activated
   by a `GET ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y`
   handshake that expects `Y` echoed back. The pipeline is POST-only; this
   challenge is not an event. Where it lives is its own design decision.

## Decision

Extend ADR-0003's vocabulary to channels. Four forks, settled in the
grilling conversation that produced this ADR:

### 1. Broaden the union (instead of parallel `InboundChannelEvent`)

`InboundDeliveryEvent` is renamed to `InboundEvent`. The new union gains
one kind:

```ts
| { kind: 'channel.received';
    channel: 'sms' | 'whatsapp' | 'generic';
    from: string;
    content: { text?: string; html?: string; subject?: string; mediaUrl?: string };
    externalMessageId?: string;
    metadata?: Record<string, string | undefined>; }
```

One pipeline, one dispatcher, one set of types covers email + channels.
"Delivery" was email-centric; the broader "Inbound event" fits SMS and
WhatsApp without strain. The rename is mechanical: `InboundDeliveryEvent`
→ `InboundEvent`, `InboundDeliveryEventKind` → `InboundEventKind`,
`InboundDeliveryEventOf` → `InboundEventOf`, the dispatcher function
follows.

### 2. One kind, channel as data (instead of per-channel kinds)

`channel.received` carries `channel: 'sms' | 'whatsapp' | 'generic'` as a
discriminator *field*, not as the kind discriminator. Mirrors
`inbound.received`: one event kind regardless of which MTA produced it.
The dispatcher gets one entry. The per-channel fork lives in adapters,
where it belongs.

Per-channel kinds (`channel.sms_received | channel.whatsapp_received |
channel.generic_received`) would have re-introduced a smear *inside* the
dispatcher — three near-identical entries calling the same mutation.

### 3. GET challenge in the outer HTTP shell (not the pipeline)

`runInboundPipeline` stays POST-only. Meta's `httpAction` wraps:

```ts
export const handleWhatsAppWebhook = httpAction(async (ctx, req) => {
  if (req.method === 'GET') return handleMetaChallenge(req);
  return runInboundPipeline(ctx, req, metaAdapter);
});
```

`handleMetaChallenge(request): Response` is exported from
`webhooks/adapters/meta.ts` alongside its `InboundAdapter` — co-located
with everything Meta-specific. The challenge is not an event; forcing it
through the event pipeline would couple the pipeline to one provider's
protocol quirk.

### 4. Adapter-owned success response

`InboundAdapter` gains one optional field:

```ts
interface InboundAdapter {
  readonly source: string;
  verifySignature(req: Request, rawBody: string): Promise<...>;
  parseEvent(rawBody: string): InboundEvent | null;
  successResponse?: Response | ((event: InboundEvent) => Response);  // NEW
}
```

Twilio ships a static TwiML XML Response; Meta ships a static `200 OK`
plain Response; Generic and email adapters omit the field and inherit the
pipeline's default `jsonResponse(200, {success: true, kind})`. The pipeline
change is one line: `adapter.successResponse ? resolve(adapter.successResponse, event) : jsonResponse(...)`.

### Adjacent rename: `'webhook'` → `'generic'`

The current channel literal `'webhook'` (for the generic shared-secret
adapter) sits inside `webhooks/channels.ts` and is doubly confusing — every
inbound *path* in this module is a "webhook," so calling one channel
`'webhook'` is meaningless. The clean name is `'generic'`. Renamed in this
pass; pre-prod data migration.

## Considered options

### Union scope

1. **Parallel `InboundChannelEvent` union** with its own dispatcher.
   Cleaner separation ("email delivery" vs "channel customer messages"),
   but duplicates ~100 LOC of pipeline machinery. The deletion test from
   LANGUAGE.md leans against — deleting the parallel pipeline concentrates
   the same code at one site. Rejected.
2. **Keep `InboundDeliveryEvent` name, broaden description.** The word
   "delivery" tied to email postage doesn't fit SMS or WhatsApp; the term
   would carry a semantic mismatch. Rejected.
3. **Rename to `InboundEvent`** *(chosen)*.

### Channel event kind shape

1. **Per-channel kinds** (`channel.sms_received | …`). Three dispatch
   entries; each calls the same mutation with a different literal. The
   smear migrates into the dispatcher. Rejected.
2. **One kind, channel as data** *(chosen)*.

### GET verification challenge home

1. **Pipeline grows GET handling** — adapter declares `handleGet?(request)`.
   Couples pipeline to one provider's quirk; cannot generalize because
   only Meta uses this pattern today. Rejected.
2. **Sibling helper** `runChallengeResponse(request, adapter)`. Two
   protocols for one provider. Rejected.
3. **Outer HTTP shell branch** *(chosen)*. Pipeline contract stays
   "events are POST." When a second handshake protocol lands, the helper
   promotes into `webhooks/protocolHandshakes.ts`.

### Success response shape

1. **HTTP shell wraps and transforms** the pipeline's response post-hoc.
   Per-channel wrapper boilerplate. Rejected.
2. **Pipeline takes `responseFormat: 'json' | 'twiml' | 'plain'` config.**
   Coarse-grained; doesn't generalize to non-trivial response bodies.
   Rejected.
3. **Adapter-owned `successResponse?`** *(chosen)*. Provider quirks live
   on the provider's adapter. Pipeline default is JSON; non-JSON adapters
   override.

## Consequences

### Files that collapse / disappear

- `webhooks/channels.ts` shrinks from 390 LOC. The three `httpAction`
  handlers become one-liners (Meta's keeps its GET branch). The inline
  helpers `verifyTwilioSignature`, `twilioValidationString`,
  `verifyMetaSignature`, and `configError` either move into adapters or
  are deleted entirely (the pipeline already handles the 503-no-secret
  fail-closed path via `verifySignature`'s `{ok: false; status}` shape).
- The existing un-unit-tested signature verification math moves into
  adapters where it gets covered for the first time.

### Files that grow

- `webhooks/adapters/twilio.ts` — `source: 'twilio'`, HMAC-SHA1 over
  canonical (URL + sorted params), `successResponse: <TwiML XML>`.
- `webhooks/adapters/meta.ts` — `source: 'meta'`, HMAC-SHA256 with
  `sha256=` prefix strip, `successResponse: <plain 200>`. Also exports
  `handleMetaChallenge(request): Response`.
- `webhooks/adapters/generic.ts` — `source: 'generic'`, shared-secret in
  `x-webhook-secret` or `Authorization: Bearer`. No `successResponse`
  (inherits pipeline default).
- `webhooks/types.ts` — `InboundDeliveryEvent` renamed to `InboundEvent`;
  `channel.received` kind added; `InboundAdapter` gains
  `successResponse?`.
- `webhooks/dispatcher.ts` — one entry routing `channel.received` to
  `processInboundChannel` (JSON-stringifies `content` and `metadata` per
  the mutation's wire shape).
- `webhooks/pipeline.ts` — one-line change resolving `adapter.successResponse`
  when present.

### Schema migration (pre-prod, breaking)

- `unifiedMessages.channel` literal union: `'webhook'` → `'generic'` in
  `schema/messaging.ts`.
- `channelConfigs.channel` literal union: same.
- `processInboundChannel` mutation arg validator updated to match.
- `migrations/0005_channel_generic_rename.ts` — Convex internal mutation
  walks both tables rewriting `channel === 'webhook'` rows in place.
- Pre-prod; no shadow window.

### Vocabulary

CONTEXT.md updated inline during the grilling session:

- **Inbound delivery event** → **Inbound event**. Broadened scope to
  include channel transports; the `channel.received` kind and channel
  discriminator field documented.
- **Inbound adapter** — entry now lists `source`, `successResponse?`,
  and the convention that non-event protocol handshakes (Meta's GET
  challenge today) live as additional helpers in the adapter module and
  run in the outer HTTP shell *before* `runInboundPipeline`.
- **Webhook dispatcher**, **Webhook event**, **Webhook event module**,
  **Webhook event fanout** — unchanged.
- Relationships section gains the `channel.received` routing note.

### Test surface

- `webhooks/adapters/__tests__/twilio.test.ts` — sig verify (valid,
  invalid, replayed, missing-secret), canonical-string builder (empty
  params, sort stability), parseEvent (single SMS, with media, malformed
  payload).
- `webhooks/adapters/__tests__/meta.test.ts` — sig verify; envelope walk
  (text message, image, status-update filtered out, missing entry);
  `handleMetaChallenge` (valid mode+token, mismatched token, missing
  query params, missing `META_VERIFY_TOKEN` → 503).
- `webhooks/adapters/__tests__/generic.test.ts` — secret valid/invalid;
  both header variants; payload heuristics.
- `__tests__/channelInboundFlow.integration.test.ts` — one end-to-end
  per provider: raw HTTPS request → `unifiedMessages` row inserted.

The three channel handlers were not unit-tested before; this ADR ships
net-new coverage on three signature schemes.

### Wire contract

- Twilio receives the same TwiML XML `<?xml ... <Response/>` byte-for-byte.
- Meta receives the same `200 OK` on POST and same challenge-string echo on GET.
- Generic receives the same `{success: true}` JSON envelope.
- Customer-visible behavior is unchanged.

## Follow-up work

1. **Subscribable `channel.received` Webhook event.** Today channel
   messages dispatch internally via `processInboundChannel`. Customers
   asking for "tell me when a customer SMSes our number" would graduate
   `channel.received` into a subscribable outbound **Webhook event** with
   its own Webhook event module (per ADR-0003).

2. **`webhooks/protocolHandshakes.ts`.** Promote `handleMetaChallenge`
   out of `meta.ts` when a second protocol handshake lands (Slack URL
   verification, Twitter/X subscription challenges, etc.). One = stays
   in adapter. Two = real seam (LANGUAGE.md).

3. **`processInboundChannel`'s `'chat'` arg.** The validator accepts
   `'chat'` only because `chat.ts` (in-app messaging, not inbound)
   writes to `unifiedMessages` through the same shape. Either drop
   `'chat'` from `processInboundChannel`'s validator (narrowing to the
   inbound subset) or route in-app chat through a distinct mutation.
   Out of scope; flagged for cleanup.

## Execution

See `docs/adr/0045-execution-plan.md`.
