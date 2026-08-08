/**
 * WhatsApp Channel Adapter (WhatsApp Business API via Meta) — OUTBOUND ONLY.
 *
 * Sends WhatsApp messages through the Meta Cloud API. Inbound Meta webhooks
 * (the `X-Hub-Signature-256` check, the `hub.verify_token` handshake and
 * payload normalization) belong to `webhooks/adapters/meta.ts`, which is the
 * half the HTTP route actually calls.
 */

import type {
	ChannelAdapter,
	OutboundMessage,
	SendResult,
	DeliveryStatus,
	ChannelHealth,
} from './types';

interface WhatsAppConfig {
	phoneNumberId: string;
	accessToken: string;
}

interface WhatsAppSendResponse {
	messages?: Array<{ id?: string }>;
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
					Authorization: `Bearer ${this.config.accessToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
			});

			if (response.ok) {
				const data = (await response.json()) as WhatsAppSendResponse;
				return { success: true, externalMessageId: data.messages?.[0]?.id };
			}

			const errorData = await response.text();
			return { success: false, error: `WhatsApp error: ${response.status} ${errorData}` };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async getDeliveryStatus(_externalId: string): Promise<DeliveryStatus> {
		// WhatsApp delivery status comes via webhooks
		return 'sent';
	}

	async healthCheck(): Promise<ChannelHealth> {
		if (!this.config) return { status: 'down', lastError: 'Not configured' };

		try {
			const url = `https://graph.facebook.com/v18.0/${this.config.phoneNumberId}`;
			const start = Date.now();
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${this.config.accessToken}` },
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
