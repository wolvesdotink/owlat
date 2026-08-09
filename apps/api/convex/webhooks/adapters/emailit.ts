/** Emailit event semantics. Authentication is supplied by the host verifier registry. */
import type { InboundEvent } from '../types';

type EmailitEventType =
	| 'email.accepted'
	| 'email.attempted'
	| 'email.bounced'
	| 'email.complained'
	| 'email.delivered'
	| 'email.failed'
	| 'email.rejected'
	| 'email.suppressed'
	| 'email.clicked'
	| 'email.loaded'
	| 'email.scheduled'
	| 'email.received';

interface EmailitPayload {
	readonly type: EmailitEventType;
	readonly data: {
		readonly object: {
			readonly id: string;
			readonly to?: string | readonly string[];
			readonly status?: string;
			readonly created_at?: string;
			readonly updated_at?: string;
		};
	};
}

function payloadFrom(rawBody: string): EmailitPayload {
	const payload = JSON.parse(rawBody) as Partial<EmailitPayload>;
	const object = payload.data?.object;
	if (!payload.type || !object || typeof object.id !== 'string' || !object.id) {
		throw new TypeError('Malformed Emailit webhook payload');
	}
	return payload as EmailitPayload;
}

function eventTime(object: EmailitPayload['data']['object']): number {
	const at = Date.parse(object.updated_at ?? object.created_at ?? '');
	if (!Number.isFinite(at)) throw new TypeError('Emailit webhook has an invalid timestamp');
	return at;
}

function recipientOf(object: EmailitPayload['data']['object']): string | undefined {
	if (typeof object.to === 'string') return object.to;
	return Array.isArray(object.to) && typeof object.to[0] === 'string' ? object.to[0] : undefined;
}

export const emailitAdapter = {
	source: 'emailit' as const,

	parseEvent(rawBody: string): InboundEvent | null {
		const payload = payloadFrom(rawBody);
		const object = payload.data.object;
		const providerMessageId = object.id;
		const at = eventTime(object);
		const recipient = recipientOf(object);
		const providerType = 'emailit';

		switch (payload.type) {
			case 'email.accepted':
				return { kind: 'email.sent', providerMessageId, at, providerType };
			case 'email.delivered':
				return {
					kind: 'email.delivered',
					providerMessageId,
					at,
					providerType,
					...(recipient ? { recipient } : {}),
				};
			case 'email.attempted':
				return {
					kind: 'email.deferred',
					providerMessageId,
					at,
					providerType,
					...(object.status ? { reason: object.status } : {}),
				};
			case 'email.bounced':
				return {
					kind: 'email.bounced',
					providerMessageId,
					at,
					providerType,
					bounceType: 'hard',
					...(object.status ? { bounceMessage: object.status } : {}),
				};
			case 'email.complained':
				return {
					kind: 'email.complained',
					providerMessageId,
					at,
					providerType,
					...(recipient ? { recipient } : {}),
				};
			case 'email.failed':
			case 'email.rejected':
				return {
					kind: 'email.failed',
					providerMessageId,
					at,
					providerType,
					errorCode: payload.type === 'email.rejected' ? 'PROVIDER_REJECTED' : 'PROVIDER_FAILED',
					errorMessage: object.status ?? payload.type,
					...(recipient ? { recipient } : {}),
				};
			case 'email.suppressed':
				if (!recipient) throw new TypeError('Emailit suppression has no recipient');
				return {
					kind: 'email.provider_suppressed',
					providerMessageId,
					at,
					providerType,
					recipient,
					reason: 'recipient_blacklisted',
				};
			default:
				// First-party tracking remains authoritative; scheduling/receiving do
				// not change Owlat's outbound Send lifecycle.
				return null;
		}
	},
};
