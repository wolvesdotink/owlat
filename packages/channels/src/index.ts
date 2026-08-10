/**
 * @owlat/channels — inbound mail normalization
 *
 * One job: turn a vendor's inbound-mail webhook envelope into the canonical
 * `InboundEmailMessage` that `internal.inbound.receiveMessage` persists. The
 * registry is keyed by source (`mta`, `resend`, …), so adding a source is one
 * adapter plus one `registerInboundChannelAdapter()` call and no handler edit.
 *
 * The package once also carried a bidirectional `ChannelAdapter` surface with
 * five implementations. Per D10 that half is gone: the two that faked their
 * answers (`EmailAdapter`, `ChatAdapter`) are deleted outright, and the three
 * that really talk to a provider — Twilio SMS, Meta WhatsApp, generic outbound
 * webhook — moved to `apps/api/convex/channels/adapters/`, next to the single
 * action that has ever constructed one.
 *
 * @example
 * ```typescript
 * import { getInboundChannelAdapter } from '@owlat/channels';
 *
 * const mail = getInboundChannelAdapter('mta').parseInbound(payload);
 * ```
 */

export {
	type InboundEmailMessage,
	type InboundSource,
	type InboundChannelAdapter,
	MtaInboundAdapter,
	ResendInboundAdapter,
	getInboundChannelAdapter,
	registerInboundChannelAdapter,
} from './inboundRegistry';
