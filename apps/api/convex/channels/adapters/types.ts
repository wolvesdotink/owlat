/**
 * Channel Adapter Interface
 *
 * The contract the three configurable outbound channel providers share
 * (Twilio SMS, Meta WhatsApp, generic HTTP webhook). See `./index.ts` for what
 * deliberately does NOT implement it — `email` belongs to the send-provider
 * seam, `chat` is native, and inbound signature verification for these same
 * channels lives in `webhooks/adapters/`.
 *
 * `ChannelType` stays the full unified-message channel set (it is the
 * discriminator carried on an `OutboundMessage`, and `unifiedMessages` rows use
 * all five); the dispatchable subset is `OutboundChannel` in
 * `lib/convexValidators.ts`.
 */

export type ChannelType = 'email' | 'sms' | 'whatsapp' | 'generic' | 'chat';

export interface OutboundMessage {
	contactId: string;
	channel: ChannelType;
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

export interface ParsedMessage {
	from: string;
	content: {
		text?: string;
		html?: string;
		subject?: string;
		mediaUrl?: string;
	};
	externalMessageId?: string;
	timestamp: number;
	metadata?: Record<string, string | undefined>;
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
 * Channel adapter interface — every channel implements this
 */
export interface ChannelAdapter {
	/** Unique channel identifier */
	id: ChannelType;

	/** Send a message through this channel */
	send(message: OutboundMessage): Promise<SendResult>;

	/** Parse an inbound webhook payload into a unified message */
	parseInbound(raw: unknown): ParsedMessage;

	/** Check delivery status of a sent message */
	getDeliveryStatus(externalId: string): Promise<DeliveryStatus>;

	/** Validate an inbound webhook signature */
	validateSignature(headers: Record<string, string>, body: string): Promise<boolean>;

	/** Report current connection health */
	healthCheck(): Promise<ChannelHealth>;
}
