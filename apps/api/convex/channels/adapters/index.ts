/**
 * Outbound channel provider adapters (NODE-SIDE HELPERS, no Convex functions).
 *
 * The three adapters an operator can actually configure and send through today
 * — Twilio SMS, the Meta WhatsApp Cloud API, and a generic outbound HTTP
 * webhook — plus the `ChannelAdapter` contract they share. Their single
 * consumer is the sibling `channels/outbound.ts` action, which builds one from
 * decrypted credentials per dispatch, delivery-status poll and health probe.
 *
 * They used to live in `@owlat/channels` alongside an `EmailAdapter` and a
 * `ChatAdapter` that only pretended to work (a `send` that hard-returned
 * failure, a `healthCheck` that hard-returned healthy, a `validateSignature`
 * that hard-returned true). Those two are deleted; these three are real, so
 * they moved here — next to their only caller — rather than staying behind a
 * package boundary that no second consumer ever crossed. `@owlat/channels` is
 * now exactly what it always load-bearingly was: inbound normalization.
 *
 * Not here, deliberately:
 *   - `email` — owned end to end by the send-provider seam
 *     (`lib/sendProviders/`) and the MTA pipeline.
 *   - `chat` — native Convex, persisted by the mutation itself; there is no
 *     provider to adapt.
 *   - INBOUND signature verification and payload parsing for these same three
 *     channels — that is `webhooks/adapters/{twilio,meta,generic}.ts`, which
 *     verify real signatures against real secrets on the real route. The old
 *     `ChannelAdapter.validateSignature`/`parseInbound` pair was a second,
 *     caller-less expression of those same rules (and had already drifted from
 *     them), so the D10 pass deleted it rather than carrying it along.
 *
 * The barrel exports only what the outbound action outside this folder needs.
 * `DeliveryStatus` is a sibling-only type: import it from './types'.
 */

export type { OutboundMessage, SendResult, ChannelHealth, ChannelAdapter } from './types';

export { SmsAdapter } from './sms';
export { WhatsAppAdapter } from './whatsapp';
export { WebhookAdapter } from './webhook';
