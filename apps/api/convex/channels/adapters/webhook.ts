'use node';

/**
 * Generic Webhook Channel Adapter — OUTBOUND ONLY.
 *
 * Delivers a message to an operator-configured external system by HTTP POST.
 * Inbound generic webhooks (the shared-secret check and payload
 * normalization) belong to `webhooks/adapters/generic.ts`, which is the half
 * the HTTP route actually calls — and which authenticates against the
 * `GENERIC_WEBHOOK_SECRET` deployment variable, not against anything here.
 *
 * The outbound POST goes through {@link fetchGuarded}: the operator-supplied
 * `outboundUrl` is an opaque config string, so it is shape-validated (https +
 * hostname + no embedded credentials, reusing the connected-apps endpoint check)
 * and then fetched with the SSRF guard (private/internal blocklist up front AND
 * at connect time, redirects refused, a hard timeout) — a raw `fetch` here would
 * be an SSRF sink.
 */

import type {
	ChannelAdapter,
	OutboundMessage,
	SendResult,
	DeliveryStatus,
	ChannelHealth,
} from './types';
import { fetchGuarded } from '../../lib/ssrfGuard';
import { validateConnectedAppEndpoint } from '../../connectedApps/model';

/** Hard deadline for the outbound webhook POST. */
const WEBHOOK_TIMEOUT_MS = 10_000;

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
			// Shape-gate the opaque config URL (https + hostname + no embedded
			// credentials) before it reaches the network. Throws on a bad shape,
			// which the catch below turns into a failed SendResult.
			const outboundUrl = validateConnectedAppEndpoint(this.config.outboundUrl);

			const response = await fetchGuarded(outboundUrl, {
				method: 'POST',
				protocols: ['https:'],
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contactId: message.contactId,
					content: message.content,
					threadId: message.threadId,
					metadata: message.metadata,
					timestamp: Date.now(),
				}),
				signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
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
