# @owlat/channels

Inbound mail normalization. One registry, keyed by source, that turns whatever
shape a vendor puts on the wire into the single `InboundEmailMessage` the rest
of Owlat stores and threads.

```ts
import { getInboundChannelAdapter } from '@owlat/channels';

const mail = getInboundChannelAdapter('mta').parseInbound(payload);
```

## What is here

| Export                            | What it does                                                        |
| --------------------------------- | ------------------------------------------------------------------- |
| `InboundEmailMessage`             | The canonical shape. Everything downstream reads this, never a vendor payload |
| `InboundChannelAdapter`           | `{ source, parseInbound(raw) }` — the whole contract                 |
| `MtaInboundAdapter`               | `owlat-mta`'s `inbound.received` envelope, including its SPF/DKIM/DMARC verdicts |
| `ResendInboundAdapter`            | Registered but not a real inbound path yet — Resend does not route inbound mail |
| `getInboundChannelAdapter(source)`| Lookup; throws on an unregistered source so an unknown vendor fails loudly |
| `registerInboundChannelAdapter()` | Registration; how a new source arrives without a handler edit         |

Adding a source is one adapter file and one `registerInboundChannelAdapter()`
call. The consumer — `apps/api/convex/webhooks/adapters/mta.ts` — asks the
registry and never knows which vendor answered.

The auth verdicts are optional on purpose. An older MTA, or one with a check
disabled, omits them, and a missing verdict must render as *unknown*. Never
read an absent `spfResult` as a pass.

## What is deliberately NOT here

This package used to advertise a bidirectional `ChannelAdapter` interface with
five implementations, and the name still says "channels" for that reason. Per
decision D10 of the seams program that half is gone, because a second provider
abstraction that answered nothing the send-provider seam already answers was
costing more than it carried — and two of its five members faked their answers,
which is worse than absent.

- **`EmailAdapter` and `ChatAdapter` are deleted.** Their `send` hard-returned
  failure (or a fabricated success), their `healthCheck` hard-returned healthy
  without probing anything, and their `validateSignature` hard-returned `true`.
  A caller that trusted any of the three would have been wrong, and nothing in
  the repository called them.
- **`SmsAdapter`, `WhatsAppAdapter` and `WebhookAdapter` moved** to
  `apps/api/convex/channels/adapters/`. These three are real — they talk to
  Twilio, the Meta Cloud API and a configured HTTP endpoint — and they have
  exactly one consumer, the `channels/outbound.ts` action that decrypts an
  operator's credentials and dispatches through them. Nothing crossed the
  package boundary, so the boundary was doing no work. **Their inbound half did
  not move: it was deleted.** `parseInbound` and `validateSignature` restated,
  with no caller and some already-visible drift, what
  `apps/api/convex/webhooks/adapters/{twilio,meta,generic}.ts` do on the live
  route. The relocated contract is outbound only — `send`,
  `getDeliveryStatus`, `healthCheck`.

Sending **email** is not a channel adapter question at all: it belongs to the
send-provider seam (`apps/api/convex/lib/sendProviders/` and the catalog in
`@owlat/shared`). Verifying an **inbound webhook signature** belongs to
`apps/api/convex/webhooks/adapters/`, where the verifiers check real secrets.
Neither is reimplemented here.

## Testing

```sh
cd packages/channels && npx vitest run
```
