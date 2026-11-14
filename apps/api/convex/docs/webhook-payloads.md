# Webhook Payload Contract

**Status: FROZEN as of payloadVersion 1.**

Any change to a payload shape below — renaming a field, changing a type, dropping a field, or changing what a field means — is a breaking change for customer-side receivers and requires bumping `CURRENT_WEBHOOK_PAYLOAD_VERSION` in `lib/constants.ts`. Adding a field to `data` is additive and needs no bump: receivers are told to ignore fields they do not know, and the public docs say so.

Existing rows in `webhookDeliveryLogs` carry a `payloadVersion` field; readers must branch on it when re-rendering historical events.

## Envelope

Every webhook payload is wrapped in this envelope:

```json
{
  "event": "<event-name>",
  "timestamp": "<ISO-8601 UTC>",
  "data": { /* event-specific, see below */ }
}
```

The HTTP request body is the JSON-stringified envelope. Both HMAC signatures are computed over that exact string.

Headers sent with every webhook delivery:
- `X-Owlat-Signature` — `t=<timestamp>,v1=<hex>`, where `v1` is HMAC-SHA256 over `${t}.${X-Webhook-Delivery-Id}.${body}` (built in `webhooks/outboundSignature.ts`)
- `X-Signature` — deprecated, removed after the next release: HMAC-SHA256 over the body alone, hex-encoded
- `X-Timestamp` — Unix seconds when the delivery was attempted; the same value as `t`
- `X-Webhook-Id` — Convex ID of the webhook subscription
- `X-Webhook-Delivery-Id` — ID of this delivery (its delivery-log row); identical on every retry, so receivers can deduplicate redeliveries
- `X-Webhook-Attempt` — attempt number of this request, starting at 1
- `User-Agent` — `Owlat-Webhooks/1.0`
- `Content-Type` — `application/json`

## `data` shape constraints

`data` is currently a flat map of primitive values: `string | number | boolean | null`. Nested arrays or objects MUST be JSON-encoded as a string field (see `topic.unsubscribed.listsRemoved` for an example). A future payload version may relax this to allow nested structures.

## Per-event payloads

### Send identity on every `email.*` event

Every `email.*` event carries `sendId`, `campaignId` and `templateId`, always present and `null` when they do not apply (`webhooks/events/sendIdentity.ts`, filled by `sendIdentityOf` in `delivery/sendLifecycle/lookups.ts`).

- `sendId` is set only for a `transactionalSends` row of `kind: 'transactional'`: the id `POST /api/v1/transactional` answered with and `GET /api/v1/transactional/{sendId}` reads. Campaign, automation, inbox and preview sends carry `null`; their row ids have no public route and are not handed out.
- `campaignId` is set for campaign sends.
- `templateId` is set for transactional API sends.

### `email.sent`
Fired when a campaign or transactional email is dispatched to the provider. `transactionalEmailId` is the TEMPLATE id (equal to `templateId`), not the send id the send API returns under the same name. It keeps its meaning for receivers that read it; new receivers match on `sendId`.
```json
{
  "email": "recipient@example.com",
  "sendId": "<id the send API returned | null>",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "templateId": "<Convex Id<'transactionalEmails'> | null>",
  "transactionalEmailId": "<Convex Id<'transactionalEmails'> | null>",
  "timestamp": "<ISO-8601>"
}
```

### `email.delivered`
Fired when the receiving MTA accepts delivery.
```json
{
  "email": "recipient@example.com",
  "sendId": "<id the send API returned | null>",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "templateId": "<Convex Id<'transactionalEmails'> | null>",
  "timestamp": "<ISO-8601>"
}
```

### `email.opened`
Fired on first open (tracked via 1x1 pixel beacon). Automated pixel fetches (Apple MPP, security scanners) do not fire it; see `delivery/automatedOpens.ts`.
```json
{
  "email": "recipient@example.com",
  "sendId": "<id the send API returned | null>",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "templateId": "<Convex Id<'transactionalEmails'> | null>",
  "timestamp": "<ISO-8601>"
}
```

### `email.clicked`
Fired on each link click (via tracked URL redirect). Links followed by security gateways and link scanners do not fire it; see `delivery/automatedClicks.ts`.
```json
{
  "email": "recipient@example.com",
  "sendId": "<id the send API returned | null>",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "templateId": "<Convex Id<'transactionalEmails'> | null>",
  "url": "https://www.example.com/landing",
  "timestamp": "<ISO-8601>"
}
```

### `email.bounced`
Fired on hard or soft bounce reported by the provider.
```json
{
  "email": "recipient@example.com",
  "sendId": "<id the send API returned | null>",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "templateId": "<Convex Id<'transactionalEmails'> | null>",
  "bounceType": "hard" | "soft",
  "message": "<provider-supplied reason or ''>",
  "timestamp": "<ISO-8601>"
}
```

### `email.complained`
Fired when the recipient marks the email as spam (feedback loop from provider).
```json
{
  "email": "recipient@example.com",
  "sendId": "<id the send API returned | null>",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "templateId": "<Convex Id<'transactionalEmails'> | null>",
  "timestamp": "<ISO-8601>"
}
```

### `email.failed`
Fired once when a send reaches the terminal `failed` state (`reduceFailed` in `delivery/sendLifecycle/reducers.ts`). Never for a bounce, never for a send that is held or retried, never twice: a repeated failure is a duplicate transition and emits nothing. Never for a campaign or automation send that was skipped at dispatch because its recipient is suppressed, unsubscribed or deleted (`RECIPIENT_SUPPRESSED`, `RECIPIENT_UNSUBSCRIBED`, `CONTACT_DELETED`): that is not a delivery failure, the send row and the campaign report still show it. A send accepted by the transactional API (`sendId` set) does fire it for those codes, since its caller was answered `202`. `errorCode` is the code stored on the send row; `message` is its `errorMessage`. Webhooks subscribe to it explicitly, like every event: an existing webhook does not receive it until its event list includes it.
```json
{
  "email": "recipient@example.com",
  "sendId": "<id the send API returned | null>",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "templateId": "<Convex Id<'transactionalEmails'> | null>",
  "errorCode": "MTA_UNREACHABLE",
  "message": "<human-readable reason>",
  "timestamp": "<ISO-8601>"
}
```

### `contact.created`
Fired when a new contact is added via API, form, or import.
```json
{
  "contactId": "<Convex Id<'contacts'>>",
  "email": "person@example.com",
  "source": "api" | "import" | "form" | "transactional" | "inbound",
  "timestamp": "<ISO-8601>"
}
```

### `topic.unsubscribed`
Fired when a contact unsubscribes from one or more topics.
```json
{
  "contactId": "<Convex Id<'contacts'>>",
  "email": "person@example.com",
  "unsubscribedAt": "<epoch ms>",
  "listsRemoved": "[{\"topicId\":\"...\",\"topicName\":\"...\"}]"
}
```

`listsRemoved` is a JSON-encoded string (current shape constraint requires flat primitives). Receivers must `JSON.parse` it to access the array.

### `test`
Sent by `sendTestWebhook` mutation to validate a receiver endpoint.
```json
{
  "message": "This is a test webhook from Owlat",
  "webhookId": "<Convex Id<'webhooks'>>",
  "webhookName": "<user-set label>"
}
```

## Versioning

When this contract changes:
1. Bump `CURRENT_WEBHOOK_PAYLOAD_VERSION` in `lib/constants.ts`.
2. Append a new section here documenting the v2 shapes alongside v1.
3. Decide a deprecation strategy: dual-emit, version-pinned subscriptions, or hard cutover.
4. Update SDK docs.

Adding a new event type is NOT a breaking change as long as existing subscribers don't filter strictly. Subscriptions list their events explicitly (`enqueueFanoutDeliveries` matches on `webhooks.events`), so a new event reaches no existing webhook until someone ticks it. New events require:
1. A module under `webhooks/events/<name>/` and its entry in `webhooks/events/registry.ts`.
2. The literal in both validators in `webhooks/events.ts` (the schema's `webhooks.events` and `webhookDeliveryLogs.event` read them).
3. The event in the web app's list (`apps/web/app/composables/useWebhookForm.ts`) with en and de copy, and its delivery-log label.
4. Its `data` shape documented in this file and in `apps/docs/content/{en,de}/2.api/12.webhook-payloads.md`.
