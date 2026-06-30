/**
 * WhatsApp Channel Adapter (WhatsApp Business API via Meta)
 *
 * Sends and receives WhatsApp messages via the Meta Cloud API.
 */

import type { ChannelAdapter, OutboundMessage, SendResult, ParsedMessage, DeliveryStatus, ChannelHealth } from './types';

interface WhatsAppConfig {
	phoneNumberId: string;
	accessToken: string;
	verifyToken: string; // For webhook verification
}

interface WhatsAppSendResponse {
	messages?: Array<{ id?: string }>;
}

interface WhatsAppInboundMessage {
	from?: string;
	id?: string;
	timestamp?: string;
	text?: { body?: string };
	image?: { url?: string };
	document?: { url?: string };
}

interface WhatsAppInboundPayload {
	entry?: Array<{
		changes?: Array<{
			value?: {
				messages?: WhatsAppInboundMessage[];
				contacts?: Array<{ profile?: { name?: string } }>;
			};
		}>;
	}>;
}

export class WhatsAppAdapter implements ChannelAdapter {
	id = 'whatsapp' as const;
	private config: WhatsAppConfig | null = null;

	configure(config: WhatsAppConfig) {
		this.config = config;
	}

	async send(message: OutboundMessage): Promise<SendResult> {
		if (!this.config) {
			return { success: false, error: 'WhatsApp adapter not configured' };
		}

		try {
			const url = `https://graph.facebook.com/v18.0/${this.config.phoneNumberId}/messages`;

			const payload = {
				messaging_product: 'whatsapp',
				to: message.metadata?.['phoneNumber'] ?? '',
				type: 'text',
				text: { body: message.content.text ?? '' },
			};

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.config.accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
			});

			if (response.ok) {
				const data = await response.json() as WhatsAppSendResponse;
				return { success: true, externalMessageId: data.messages?.[0]?.id };
			}

			const errorData = await response.text();
			return { success: false, error: `WhatsApp error: ${response.status} ${errorData}` };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	parseInbound(raw: unknown): ParsedMessage {
		const payload = raw as WhatsAppInboundPayload;
		// Meta webhook format
		const entry = payload.entry?.[0];
		const change = entry?.changes?.[0];
		const value = change?.value;
		const msg = value?.messages?.[0];

		return {
			from: msg?.from ?? '',
			content: {
				text: msg?.text?.body ?? '',
				mediaUrl: msg?.image?.url ?? msg?.document?.url ?? undefined,
			},
			externalMessageId: msg?.id,
			timestamp: msg?.timestamp ? parseInt(msg.timestamp) * 1000 : Date.now(),
			metadata: {
				profileName: value?.contacts?.[0]?.profile?.name,
			},
		};
	}

	async getDeliveryStatus(_externalId: string): Promise<DeliveryStatus> {
		// WhatsApp delivery status comes via webhooks
		return 'sent';
	}

	async validateSignature(_headers: Record<string, string>, _body: string): Promise<boolean> {
		// SECURITY: fail closed. Real verification requires computing
		// HMAC-SHA256 of the raw request body keyed by the Meta *app secret*
		// (delivered in `X-Hub-Signature-256` as `sha256=<hex>`). The app
		// secret is not part of WhatsAppConfig and inbound WhatsApp webhooks
		// are not wired yet, so we reject rather than accept unverified
		// requests — a presence-only check would let any forged payload
		// through. Implement HMAC verification (and add `appSecret` to the
		// config) before routing inbound WhatsApp webhooks to this adapter.
		return false;
	}

	async healthCheck(): Promise<ChannelHealth> {
		if (!this.config) return { status: 'down', lastError: 'Not configured' };

		try {
			const url = `https://graph.facebook.com/v18.0/${this.config.phoneNumberId}`;
			const start = Date.now();
			const response = await fetch(url, {
				headers: { 'Authorization': `Bearer ${this.config.accessToken}` },
			});
			const latencyMs = Date.now() - start;

			if (response.ok) {
				return { status: 'healthy', latencyMs };
			}
			return { status: 'degraded', latencyMs, lastError: `HTTP ${response.status}` };
		} catch (error) {
			return { status: 'down', lastError: error instanceof Error ? error.message : String(error) };
		}
	}
}
