# Webhook Payload Contract

**Status: FROZEN as of payloadVersion 1.**

Any change to a payload shape below — renaming a field, changing a type, dropping a field, adding a required field — is a breaking change for customer-side receivers and requires bumping `CURRENT_WEBHOOK_PAYLOAD_VERSION` in `lib/constants.ts`.

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

The HTTP request body is the JSON-stringified envelope. The HMAC signature in `X-Signature` is computed over that exact string.

Headers sent with every webhook delivery:
- `X-Signature` — HMAC-SHA256 over the body, hex-encoded
- `X-Timestamp` — Unix seconds when the delivery was attempted
- `X-Webhook-Id` — Convex ID of the webhook subscription
- `User-Agent` — `Owlat-Webhooks/1.0`
- `Content-Type` — `application/json`

## `data` shape constraints

`data` is currently a flat map of primitive values: `string | number | boolean | null`. Nested arrays or objects MUST be JSON-encoded as a string field (see `topic.unsubscribed.listsRemoved` for an example). A future payload version may relax this to allow nested structures.

## Per-event payloads

### `email.sent`
Fired when a campaign or transactional email is dispatched to the provider.
```json
{
  "email": "recipient@example.com",
  "campaignId": "<Convex Id<'campaigns'> | null>",
  "transactionalEmailId": "<Convex Id<'transactionalEmails'> | null>",
  "timestamp": "<ISO-8601>"
}
```

### `email.delivered`
Fired when the receiving MTA accepts delivery.
```json
{
  "email": "recipient@example.com",
  "timestamp": "<ISO-8601>"
}
```

### `email.opened`
Fired on first open (tracked via 1x1 pixel beacon).
```json
{
  "email": "recipient@example.com",
  "timestamp": "<ISO-8601>"
}
```

### `email.clicked`
Fired on each link click (via tracked URL redirect).
```json
{
  "email": "recipient@example.com",
  "url": "https://www.example.com/landing",
  "timestamp": "<ISO-8601>"
}
```

### `email.bounced`
Fired on hard or soft bounce reported by the provider.
```json
{
  "email": "recipient@example.com",
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

Adding a new event type is NOT a breaking change as long as existing subscribers don't filter strictly. New events require:
1. Append the event literal to `webhookEventValidator` in `lib/validators.ts`.
2. Append the same literal to the `event` field unions in `schema/webhooks.ts` (both `webhooks.events` and `webhookDeliveryLogs.event`).
3. Document the new event's `data` shape in this file.
