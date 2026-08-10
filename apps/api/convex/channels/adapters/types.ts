/**
 * Channel Adapter Interface
 *
 * The contract the three configurable outbound channel providers share
 * (Twilio SMS, Meta WhatsApp, generic HTTP webhook). See `./index.ts` for what
 * deliberately does NOT implement it — `email` belongs to the send-provider
 * seam, `chat` is native, and inbound signature verification and payload
 * parsing for these same channels live in `webhooks/adapters/`.
 *
 * OUTBOUND ONLY, on purpose. The contract carried a `parseInbound` and a
 * `validateSignature` for as long as it lived in `@owlat/channels`, and neither
 * ever had a host caller: the shipped inbound route verifies and parses through
 * `webhooks/adapters/{twilio,meta,generic}.ts`. Two expressions of one rule is
 * how a Twilio field change gets fixed in one place and silently missed in the
 * other, so the D10 honesty pass kept the verifiers that run and deleted the
 * pair that only compiled. Do not re-add an inbound half here — extend
 * `webhooks/adapters/` instead.
 *
 * The channel discriminator is not restated here. `lib/convexValidators.ts`
 * declares it once, next to the validator the schema and every function
 * argument use: `UnifiedMessageChannel` for a message's channel (all five —
 * `dispatchOutbound` accepts any of them and fails safe on the two with no
 * adapter) and its dispatchable subset `OutboundChannel` for an adapter's own
 * id, which is what makes the "no email/chat adapter here" rule a type error.
 */

import type { UnifiedMessageChannel, OutboundChannel } from '../../lib/convexValidators';

export interface OutboundMessage {
	contactId: string;
	channel: UnifiedMessageChannel;
	content: {
		text?: string;
		html?: string;
		subject?: string;
		mediaUrl?: string;
	};
	threadId?: string;
	metadata?: Record<string, string>;
}

export interface SendResult {
	success: boolean;
	externalMessageId?: string;
	error?: string;
}

export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * What a health probe reports — exactly the two things the probe's only
 * consumer persists.
 *
 * `channels/outbound.ts:probeChannelHealth` forwards `status` and `lastError`
 * to `unifiedMessages.updateChannelHealth`, which has no other argument. The
 * shape used to carry `lastSuccessfulSend`, `rateLimitRemaining` and
 * `latencyMs` as well: no adapter ever set the first two, and the third was
 * measured on every 5-minute probe and then dropped on the floor, because
 * `channelConfigs` has nowhere to put it. (`channelConfigs.lastSuccessfulSend`
 * is a real column, but it is stamped by `unifiedMessages.recordOutbound` off
 * an actual send — never by a probe.) The D10 honesty pass dropped all three;
 * persisting probe latency is a schema + mutation change, so it needs its own
 * piece rather than a member nothing reads.
 */
export interface ChannelHealth {
	status: 'healthy' | 'degraded' | 'down';
	lastError?: string;
}

/**
 * Outbound channel adapter interface — every configurable channel provider
 * implements this, and `channels/outbound.ts` calls exactly these three
 * methods (dispatch, delivery-status poll, health probe).
 */
export interface ChannelAdapter {
	/**
	 * Which channel this adapter dispatches. `OutboundChannel`, not the full
	 * `UnifiedMessageChannel` union, so the folder's "no email/chat adapter
	 * here" rule is a compile error rather than a convention: `email` is owned
	 * by the send-provider seam and `chat` is native, so an adapter claiming
	 * either id has nothing to dispatch through.
	 */
	id: OutboundChannel;

	/** Send a message through this channel */
	send(message: OutboundMessage): Promise<SendResult>;

	/** Check delivery status of a sent message */
	getDeliveryStatus(externalId: string): Promise<DeliveryStatus>;

	/** Report current connection health */
	healthCheck(): Promise<ChannelHealth>;
}
