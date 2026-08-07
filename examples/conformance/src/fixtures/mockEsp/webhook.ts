/**
 * MOCK ESP — the FEEDBACK half of the bundle.
 *
 * PARSE ONLY, which is the contract's security thesis: by the time this runs the
 * host has already verified the declared HMAC over `<timestamp>.<rawBody>` in
 * constant time, bounded the timestamp's age and refused a delivery it has
 * already accepted. So `rawBody` is authentic bytes and this module's whole job
 * is turning a provider's wire shape into the four feedback facts.
 *
 * It returns the EMPTY ARRAY for a console verification ping and for event kinds
 * Owlat does not act on — the contract's way of acknowledging a delivery that
 * carries nothing — and THROWS on a body it cannot read, which the route answers
 * 400 without dispatching anything.
 *
 * Isolate-safe: no Node builtins, because the HTTP router runs it.
 */

import type {
	PluginSendTransportWebhookModule,
	PluginWebhookFeedbackEvent,
} from '@owlat/plugin-kit';

/** The provider's imagined wire shape: `{ events: [...] }`. */
interface MockEspWireEvent {
	readonly type?: unknown;
	readonly id?: unknown;
	readonly ts?: unknown;
	readonly email?: unknown;
	readonly detail?: unknown;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toFeedbackEvent(raw: MockEspWireEvent): PluginWebhookFeedbackEvent | null {
	const at = typeof raw.ts === 'number' ? raw.ts : Number.NaN;
	if (!Number.isFinite(at)) throw new TypeError('mock-esp: event carries no timestamp');
	const id = readString(raw.id);
	switch (raw.type) {
		case 'accepted':
			if (!id) throw new TypeError('mock-esp: delivery carries no message id');
			return {
				kind: 'delivered',
				providerMessageId: id,
				at,
				...(readString(raw.email) === undefined ? {} : { recipient: readString(raw.email)! }),
			};
		case 'hard_bounce':
		case 'soft_bounce':
			if (!id) throw new TypeError('mock-esp: bounce carries no message id');
			return {
				kind: 'bounced',
				providerMessageId: id,
				at,
				bounceType: raw.type === 'hard_bounce' ? 'hard' : 'soft',
				...(readString(raw.detail) === undefined ? {} : { bounceMessage: readString(raw.detail)! }),
			};
		case 'spam_report':
			// The one event that may legitimately arrive redacted (RFC 5965 §3.2), so
			// it is allowed to name only the address.
			return {
				kind: 'complained',
				at,
				...(id === undefined ? {} : { providerMessageId: id }),
				...(readString(raw.email) === undefined ? {} : { recipient: readString(raw.email)! }),
			};
		case 'deferral':
			if (!id) throw new TypeError('mock-esp: deferral carries no message id');
			return {
				kind: 'deferred',
				providerMessageId: id,
				at,
				...(readString(raw.detail) === undefined ? {} : { reason: readString(raw.detail)! }),
			};
		default:
			// An event kind this integration does not consume. Acknowledged, not
			// refused: a 400 would make the provider redeliver it forever.
			return null;
	}
}

export const mockEspWebhook: PluginSendTransportWebhookModule = {
	parseEvents(rawBody: string): readonly PluginWebhookFeedbackEvent[] {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawBody);
		} catch {
			throw new TypeError('mock-esp: body is not JSON');
		}
		if (typeof parsed !== 'object' || parsed === null) {
			throw new TypeError('mock-esp: body is not an object');
		}
		const events = (parsed as Record<string, unknown>)['events'];
		// The console's unsigned "is this endpoint alive?" ping carries no events.
		if (events === undefined) return [];
		if (!Array.isArray(events)) throw new TypeError('mock-esp: events is not an array');
		const out: PluginWebhookFeedbackEvent[] = [];
		for (const raw of events as readonly MockEspWireEvent[]) {
			if (typeof raw !== 'object' || raw === null) {
				throw new TypeError('mock-esp: event is not an object');
			}
			const event = toFeedbackEvent(raw);
			if (event) out.push(event);
		}
		return out;
	},
};
