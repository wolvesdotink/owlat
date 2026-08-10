/**
 * Generic Webhook Channel Adapter — OUTBOUND ONLY.
 *
 * Delivers a message to an operator-configured external system by HTTP POST.
 * Inbound generic webhooks (the shared-secret check and payload
 * normalization) belong to `webhooks/adapters/generic.ts`, which is the half
 * the HTTP route actually calls — and which authenticates against the
 * `GENERIC_WEBHOOK_SECRET` deployment variable, not against anything here.
 */

import type {
	ChannelAdapter,
	OutboundMessage,
	SendResult,
	DeliveryStatus,
	ChannelHealth,
} from './types';

interface WebhookConfig {
	outboundUrl: string;
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

	async getDeliveryStatus(_externalId: string): Promise<DeliveryStatus> {
		return 'sent';
	}

	async healthCheck(): Promise<ChannelHealth> {
		if (!this.config) return { status: 'down', lastError: 'Not configured' };
		return { status: 'healthy' };
	}
}
