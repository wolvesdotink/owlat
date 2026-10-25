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
import { v } from 'convex/values';
import { validatorDecoder } from '@owlat/worker-protocol/decodeJson';
import { FETCH_TIMEOUTS, fetchWithTimeout } from '../../lib/fetchWithTimeout';

interface WhatsAppConfig {
	phoneNumberId: string;
	accessToken: string;
}

/** The Graph API's send answer, as far as a send reads it. */
const decodeSendResponse = validatorDecoder(
	v.object({ messages: v.optional(v.array(v.object({ id: v.optional(v.string()) }))) })
);

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

			const response = await fetchWithTimeout(
				url,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${this.config.accessToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(payload),
				},
				FETCH_TIMEOUTS.thirdPartyApi
			);

			if (response.ok) {
				// A 2xx means Meta took the message. An id this build cannot read is
				// not recorded; the send stays a success, so it is not sent again.
				const data = decodeSendResponse(await response.json());
				return {
					success: true,
					externalMessageId: data.ok ? data.value.messages?.[0]?.id : undefined,
				};
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
			const response = await fetchWithTimeout(
				url,
				{
					headers: { Authorization: `Bearer ${this.config.accessToken}` },
				},
				FETCH_TIMEOUTS.thirdPartyApi
			);

			if (response.ok) {
				return { status: 'healthy' };
			}
			return { status: 'degraded', lastError: `HTTP ${response.status}` };
		} catch (error) {
			return { status: 'down', lastError: error instanceof Error ? error.message : String(error) };
		}
	}
}
