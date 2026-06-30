/**
 * Generic Webhook Channel Adapter
 *
 * Sends messages to and receives messages from external systems
 * via HTTP POST webhooks.
 */

import type { ChannelAdapter, OutboundMessage, SendResult, ParsedMessage, DeliveryStatus, ChannelHealth } from './types';

interface WebhookInboundPayload {
	from?: string;
	sender?: string;
	text?: string;
	message?: string;
	html?: string;
	subject?: string;
	content?: { text?: string; html?: string; subject?: string };
	id?: string;
	messageId?: string;
	timestamp?: number;
	metadata?: Record<string, string>;
}

interface WebhookConfig {
	outboundUrl: string;
	secret: string;
}

export class WebhookAdapter implements ChannelAdapter {
	id = 'generic' as const;
	private config: WebhookConfig | null = null;

	configure(config: WebhookConfig) {
		this.config = config;
	}

	async send(message: OutboundMessage): Promise<SendResult> {
		if (!this.config) {
			return { success: false, error: 'Webhook adapter not configured' };
		}

		try {
			const response = await fetch(this.config.outboundUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contactId: message.contactId,
					content: message.content,
					threadId: message.threadId,
					metadata: message.metadata,
					timestamp: Date.now(),
				}),
			});

			return {
				success: response.ok,
				error: response.ok ? undefined : `HTTP ${response.status}`,
			};
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	parseInbound(raw: unknown): ParsedMessage {
		const payload = raw as WebhookInboundPayload;
		return {
			from: payload.from ?? payload.sender ?? 'webhook',
			content: {
				text: payload.text ?? payload.message ?? payload.content?.text,
				html: payload.html ?? payload.content?.html,
				subject: payload.subject ?? payload.content?.subject,
			},
			externalMessageId: payload.id ?? payload.messageId,
			timestamp: payload.timestamp ?? Date.now(),
			metadata: payload.metadata ?? {},
		};
	}

	async getDeliveryStatus(_externalId: string): Promise<DeliveryStatus> {
		return 'sent';
	}

	async validateSignature(headers: Record<string, string>, _body: string): Promise<boolean> {
		// Generic webhook validates a shared secret header against the
		// configured secret. Compare in constant time and never accept on mere
		// header *presence* — a presence-only check lets any value through.
		if (!this.config) return false;
		const provided = headers['x-webhook-secret'] ?? headers['authorization'];
		if (!provided) return false;
		return timingSafeStringEqual(provided, this.config.secret);
	}

	async healthCheck(): Promise<ChannelHealth> {
		if (!this.config) return { status: 'down', lastError: 'Not configured' };
		return { status: 'healthy' };
	}
}

/**
 * Constant-time string comparison. Does not short-circuit on the first
 * differing character, so it does not leak how many leading bytes matched.
 * (A length mismatch returns early — secrets are fixed-length, so this is an
 * acceptable, standard trade-off.)
 */
function timingSafeStringEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}
