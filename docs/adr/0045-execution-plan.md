# ADR-0045 — execution plan for ADR-0005 (channel inbound adapters)

> Companion execution plan for [ADR-0005](./0005-channel-inbound-adapters.md).
> Renumbered from `0005-execution-plan.md` to its own unique ADR number so the
> `000X` prefix is unambiguous (one document per number).

Phased migration for the channel inbound adapters ADR. Each phase is one
shippable PR. Existing tests pass at every phase boundary; behavior is
unchanged until the phase that explicitly migrates a wire path.

Pre-prod: no feature flags, no shadow window, no parallel-literal period.
Breaking changes (schema literal renames, type renames, adapter contract
broadening) land atomically with the code that produces them.

## Order rationale

**Foundation first.** Rename `InboundDeliveryEvent` → `InboundEvent`, add
`channel.received` to the union, broaden `InboundAdapter` with
`successResponse?`. No adapter migrations yet, no behavior change.

**Twilio before Generic before Meta.** Twilio has the simplest dispatch
(POST-only, fixed TwiML, well-specified canonical signature) and is the
best place to prove the channel-event flow end-to-end. Generic has no
HMAC — just a shared-secret compare — so the adapter is the smallest of
the three. Meta lands last because of the GET verification handshake
(the outer-shell branch) and the nested envelope walk.

**Schema rename folded into the generic adapter phase.** The
`'webhook'` → `'generic'` literal rename ships atomically with the
generic adapter (phase 3) — schema, validators, adapter output, and any
existing rows flip in one PR.

**Final cleanup folded into the Meta phase.** Once Meta lands,
`channels.ts` no longer has any inline signature math or envelope
walking; the leftover `configError` helper and other dead code drop in
the same PR.

---

## Phase 1 — Foundation (no behavior change)

**Changes**

- `webhooks/types.ts`:
  - Rename `InboundDeliveryEvent` → `InboundEvent`,
    `InboundDeliveryEventKind` → `InboundEventKind`,
    `InboundDeliveryEventOf` → `InboundEventOf`.
  - Add `channel.received` kind to the union (no dispatch entry yet —
    that's phase 2).
  - Broaden `InboundAdapter` with
    `successResponse?: Response | ((event: InboundEvent) => Response)`.
- `webhooks/dispatcher.ts`:
  - Rename `dispatchInboundDeliveryEvent` → `dispatchInboundEvent`.
- `webhooks/pipeline.ts`:
  - Final response: `adapter.successResponse ? resolve(adapter.successResponse, event) : jsonResponse(200, {success: true, kind: event.kind})`.
- Sweep callers of the renamed types across `webhooks/adapters/resend.ts`,
  `webhooks/adapters/mta.ts`, `webhooks/channels.ts`.

**Tests**

- `webhooks/__tests__/pipeline.test.ts` extended: `successResponse` is
  honored when provided (static value + function-returning-Response).
- Type-only assertion: adding `channel.received` to the union without a
  dispatcher entry triggers a compile error from the typed dispatch table.

**Done when**

- `rg "InboundDeliveryEvent"` returns no hits.
- Existing email-side adapters compile and tests pass unchanged.
- `channels.ts` is structurally unchanged (still owns the three handlers).

---

## Phase 2 — Twilio adapter

**Changes**

- `webhooks/adapters/twilio.ts` (new):
  - `source: 'twilio'`.
  - `verifySignature(req, rawBody)` — moves `verifyTwilioSignature` and
    `twilioValidationString` from `channels.ts`. Reads `TWILIO_AUTH_TOKEN`
    via `lib/env.getOptional`; fails closed with status 503 on missing
    secret.
  - `parseEvent(rawBody)` — URL-decodes the form payload; emits
    `{ kind: 'channel.received', channel: 'sms', from: payload.From, content: { text: payload.Body, mediaUrl: payload.MediaUrl0 }, externalMessageId: payload.MessageSid, metadata: {fromCity, fromState, fromCountry} }`.
  - `successResponse`: static `Response` with TwiML XML body and
    `Content-Type: text/xml`.
- `webhooks/channels.ts`:
  - `handleSmsWebhook` collapses to
    `httpAction((ctx, req) => runInboundPipeline(ctx, req, twilioAdapter))`.
- `webhooks/dispatcher.ts`:
  - Add the `channel.received` entry routing to
    `internal.webhooks.channels.processInboundChannel` (JSON-stringifies
    `content` and `metadata` per the mutation's wire shape).

**Tests**

- `webhooks/adapters/__tests__/twilio.test.ts`:
  - `verifySignature`: valid signature, tampered body, replayed (Twilio
    has no timestamp — note this in the test), missing secret → 503.
  - `twilioValidationString`: empty params, single param, sorted-key
    ordering invariant under random insertion order.
  - `parseEvent`: text-only message, MMS with `MediaUrl0`, missing
    `From` (returns null or throws — pick one and assert).
- `webhooks/__tests__/channelInboundFlow.integration.test.ts`: raw HTTPS
  POST → `unifiedMessages` row insert.

**Removed**

- `verifyTwilioSignature`, `twilioValidationString` from `channels.ts`.
- The inline `URLSearchParams` body parse in `handleSmsWebhook`.

**Done when** — `handleSmsWebhook` is one line; an SMS round-trip via raw
HTTPS produces a `unifiedMessages` row.

---

## Phase 3 — Generic adapter + channel literal rename

This phase ships the generic adapter *and* renames the channel literal
`'webhook'` → `'generic'` everywhere it appears. Pre-prod, so the schema
flip and data backfill happen in the same PR as the adapter.

**Changes**

- `webhooks/adapters/generic.ts` (new):
  - `source: 'generic'`.
  - `verifySignature(req, rawBody)` — constant-time compare against
    `GENERIC_WEBHOOK_SECRET` from either `x-webhook-secret` or
    `Authorization` (with `Bearer ` prefix stripped). 503 on missing
    secret.
  - `parseEvent(rawBody)` — JSON-parses body; the
    `{from ?? sender ?? 'webhook'}` heuristic; the
    `{text ?? message ?? content?.text}` cascade. Emits
    `{ kind: 'channel.received', channel: 'generic', ... }`.
  - No `successResponse` — inherits the pipeline's default JSON.
- `webhooks/channels.ts`:
  - `handleGenericWebhook` collapses to one line.
- `schema/messaging.ts`:
  - `unifiedMessages.channel` union:
    `v.literal('webhook')` → `v.literal('generic')`.
  - `channelConfigs.channel` union: same.
- `processInboundChannel` mutation arg validator updated to match.
- `migrations/0005_channel_generic_rename.ts` — Convex internal mutation
  walks `unifiedMessages` and `channelConfigs`, rewriting rows where
  `channel === 'webhook'` to `channel === 'generic'`. Idempotent.

**Tests**

- `webhooks/adapters/__tests__/generic.test.ts`:
  - `verifySignature`: secret in `x-webhook-secret`, secret in
    `Authorization`, secret in `Authorization: Bearer ...`, both headers
    present (one wins), missing secret → 503, wrong secret → 401.
  - `parseEvent`: minimum payload `{from, text}`, sender/message alias
    keys, missing `from` (falls back to `'webhook'`), nested
    `content.text` / `content.html` / `content.subject`, malformed JSON
    → throws.
- `migrations/__tests__/0005_channel_generic_rename.test.ts`: fixture
  with mixed-channel rows; assert rewrite count and idempotence.
- Existing channel integration tests retargeted to expect
  `channel: 'generic'`.

**Removed**

- The inline secret comparison + payload parsing in
  `handleGenericWebhook`.
- `v.literal('webhook')` from both messaging tables.

**Done when**

- `handleGenericWebhook` is one line.
- `rg "v\\.literal\\('webhook'\\)"` returns no hits.
- `rg "channel.*=.*'webhook'"` returns no hits outside the migration.
- `unifiedMessages.channel === 'webhook'` is impossible at the type
  level.

---

## Phase 4 — Meta (WhatsApp) adapter + final cleanup

**Changes**

- `webhooks/adapters/meta.ts` (new):
  - Default export `metaAdapter: InboundAdapter`:
    - `source: 'meta'`.
    - `verifySignature(req, rawBody)` — HMAC-SHA256 of `rawBody` with
      `META_APP_SECRET`; compares against `x-hub-signature-256` after
      stripping `sha256=`. 503 on missing secret.
    - `parseEvent(rawBody)` — walks
      `entry[0].changes[0].value.messages[0]`; filters status updates
      (returns null when no `messages`); emits
      `{ kind: 'channel.received', channel: 'whatsapp', from: msg.from, content: { text: msg.text?.body, mediaUrl: msg.image?.url ?? msg.document?.url }, externalMessageId: msg.id, metadata: {profileName: value.contacts[0].profile.name} }`.
    - `successResponse`: static `Response('OK', { status: 200 })`.
  - Named export `handleMetaChallenge(request: Request): Response` — the
    GET verification handshake. Reads `META_VERIFY_TOKEN`; 503 on missing
    secret. Constant-time compares `hub.verify_token`; echoes
    `hub.challenge` on match, 403 on mismatch.
- `webhooks/channels.ts`:
  - `handleWhatsAppWebhook` becomes:
    ```ts
    httpAction(async (ctx, req) => {
      if (req.method === 'GET') return handleMetaChallenge(req);
      return runInboundPipeline(ctx, req, metaAdapter);
    });
    ```
- Final cleanup of `channels.ts`:
  - Delete `configError(provider)` — the pipeline owns 503-no-secret via
    `verifySignature`'s `{ok: false; status}` shape.
  - Drop any now-unused imports.

**Tests**

- `webhooks/adapters/__tests__/meta.test.ts`:
  - `verifySignature`: valid `sha256=<hex>`, missing prefix, tampered
    body, missing secret → 503.
  - `parseEvent`: text message, image message, document message, status
    update (returns null), missing `entry`, missing
    `messages` array.
  - `handleMetaChallenge`: valid `mode=subscribe` + correct token →
    challenge echoed; wrong token → 403; missing `META_VERIFY_TOKEN` →
    503; missing query params → 403.
- Integration smoke for both GET (challenge) and POST (message) paths.

**Removed**

- `verifyMetaSignature` from `channels.ts`.
- The inline Meta envelope walk in `handleWhatsAppWebhook`.
- `configError` helper.

**Done when**

- `handleWhatsAppWebhook` is one line plus the GET branch.
- `webhooks/channels.ts` is ≤ ~100 LOC (down from 390), holding only
  the three thin handlers + the `processInboundChannel` internal
  mutation.
- `webhooks/channels.ts` contains no inline signature math or envelope
  parsing.

---

## Phase summary

| Phase | What | Wire-visible risk |
|---|---|---|
| 1 | Foundation: rename type, add `channel.received`, broaden adapter | None |
| 2 | Twilio adapter | Low (pre-prod) |
| 3 | Generic adapter + channel literal `'webhook'` → `'generic'` | Low (pre-prod schema migration) |
| 4 | Meta adapter + GET handshake + final `channels.ts` cleanup | Low (pre-prod) |

Estimated 4 PRs.

## Verification checkpoints

- After phase 1: every existing webhook integration test passes; `tsc` is
  clean; `rg "InboundDeliveryEvent"` returns no hits.
- After phase 3: `rg "'webhook'"` inside `apps/api/convex/webhooks` and
  `apps/api/convex/schema` returns no hits; channel events emit
  `channel: 'generic'` from the wire shape down to the stored row.
- After phase 4: all three channel handlers are one-liners (plus Meta's
  GET branch); `webhooks/channels.ts` no longer contains signature math
  or envelope-parsing code; the file is ≤ ~100 LOC.
