/**
 * SMS Channel Adapter (Twilio)
 *
 * Sends and receives SMS via the Twilio API.
 */

import type { ChannelAdapter, OutboundMessage, SendResult, ParsedMessage, DeliveryStatus, ChannelHealth } from './types';

interface TwilioConfig {
	accountSid: string;
	authToken: string;
	fromNumber: string;
}

interface TwilioSendResponse {
	sid?: string;
}

interface TwilioStatusResponse {
	status?: string;
}

interface TwilioInboundPayload {
	From?: string;
	Body?: string;
	MediaUrl0?: string;
	MessageSid?: string;
	FromCity?: string;
	FromState?: string;
	FromCountry?: string;
}

export class SmsAdapter implements ChannelAdapter {
	id = 'sms' as const;
	private config: TwilioConfig | null = null;

	configure(config: TwilioConfig) {
		this.config = config;
	}

	/** Basic-auth header value for the configured Twilio account. */
	private authHeader(config: TwilioConfig): string {
		const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
		return `Basic ${auth}`;
	}

	/** Twilio REST URL for the configured account, with an optional path suffix. */
	private accountUrl(config: TwilioConfig, suffix = ''): string {
		return `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}${suffix}`;
	}

	async send(message: OutboundMessage): Promise<SendResult> {
		if (!this.config) {
			return { success: false, error: 'SMS adapter not configured' };
		}

		try {
			const url = this.accountUrl(this.config, '/Messages.json');

			const body = new URLSearchParams({
				To: message.metadata?.['phoneNumber'] ?? '',
				From: this.config.fromNumber,
				Body: message.content.text ?? '',
			});

			if (message.content.mediaUrl) {
				body.append('MediaUrl', message.content.mediaUrl);
			}

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Authorization': this.authHeader(this.config),
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: body.toString(),
			});

			if (response.ok) {
				const data = await response.json() as TwilioSendResponse;
				return { success: true, externalMessageId: data.sid };
			}

			const errorData = await response.text();
			return { success: false, error: `Twilio error: ${response.status} ${errorData}` };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	parseInbound(raw: unknown): ParsedMessage {
		const payload = raw as TwilioInboundPayload;
		return {
			from: payload.From ?? '',
			content: {
				text: payload.Body ?? '',
				mediaUrl: payload.MediaUrl0 ?? undefined,
			},
			externalMessageId: payload.MessageSid,
			timestamp: Date.now(),
			metadata: {
				fromCity: payload.FromCity,
				fromState: payload.FromState,
				fromCountry: payload.FromCountry,
			},
		};
	}

	async getDeliveryStatus(externalId: string): Promise<DeliveryStatus> {
		// Fail-safe sentinel: this method returns a status enum (not an error), so
		// any condition where the *terminal* delivery state is unknown right now
		// must resolve to `sent` (no-change), never `failed`. `failed` is reserved
		// for a confirmed terminal Twilio `failed`/`undelivered` status. A caller
		// that treats `failed` as a forward transition (the delivery-status poller)
		// would otherwise permanently mis-mark a delivered SMS on a single
		// transient 429/503/timeout, since such rows then leave the re-poll set.
		if (!this.config) return 'sent';

		try {
			const url = this.accountUrl(this.config, `/Messages/${externalId}.json`);

			const response = await fetch(url, {
				headers: { 'Authorization': this.authHeader(this.config) },
			});

			if (response.ok) {
				const data = await response.json() as TwilioStatusResponse;
				const statusMap: Record<string, DeliveryStatus> = {
					'queued': 'queued',
					'sent': 'sent',
					'delivered': 'delivered',
					'read': 'read',
					'failed': 'failed',
					'undelivered': 'failed',
				};
				return (data.status ? statusMap[data.status] : undefined) ?? 'sent';
			}
			// Non-2xx (429/5xx, or a 404 before the SID propagates) is transient and
			// non-terminal — report the no-change sentinel so the caller re-polls.
			return 'sent';
		} catch {
			// Network/parse error: the status is simply unknown right now. Report
			// the no-change sentinel (`sent`) so the caller polls again next tick.
			return 'sent';
		}
	}

	async validateSignature(_headers: Record<string, string>, _body: string): Promise<boolean> {
		// SECURITY: fail closed. Twilio's `X-Twilio-Signature` is HMAC-SHA1 of
		// the full request URL plus the sorted POST params, keyed by the auth
		// token — none of which (notably the request URL) is available to this
		// header+body interface. Inbound SMS webhooks are not wired yet, so we
		// reject rather than accept on mere header presence (which any forged
		// request can satisfy). Implement full Twilio verification before
		// routing inbound SMS webhooks to this adapter.
		return false;
	}

	async healthCheck(): Promise<ChannelHealth> {
		if (!this.config) return { status: 'down', lastError: 'Not configured' };

		try {
			const url = this.accountUrl(this.config, '.json');

			const start = Date.now();
			const response = await fetch(url, {
				headers: { 'Authorization': this.authHeader(this.config) },
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
