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
 * The channel discriminator is the unified-message channel union itself
 * (`UnifiedMessageChannel`), declared once by `lib/convexValidators.ts` next to
 * the validator the schema and every function argument use. The dispatchable
 * subset — the three channels that actually reach an adapter here — is
 * `OutboundChannel` in that same module.
 */

import type { UnifiedMessageChannel } from '../../lib/convexValidators';

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

export interface ChannelHealth {
	status: 'healthy' | 'degraded' | 'down';
	lastSuccessfulSend?: number;
	lastError?: string;
	rateLimitRemaining?: number;
	latencyMs?: number;
}

/**
 * Outbound channel adapter interface — every configurable channel provider
 * implements this, and `channels/outbound.ts` calls exactly these three
 * methods (dispatch, delivery-status poll, health probe).
 */
export interface ChannelAdapter {
	/** Unique channel identifier */
	id: UnifiedMessageChannel;

	/** Send a message through this channel */
	send(message: OutboundMessage): Promise<SendResult>;

	/** Check delivery status of a sent message */
	getDeliveryStatus(externalId: string): Promise<DeliveryStatus>;

	/** Report current connection health */
	healthCheck(): Promise<ChannelHealth>;
}
