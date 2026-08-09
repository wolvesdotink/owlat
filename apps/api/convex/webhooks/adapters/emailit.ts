/** Emailit event semantics. Authentication is supplied by the host verifier registry. */
import { classifyBounceMessage } from '@owlat/shared/bounceClassification';
import type { InboundEvent, InboundEventOf } from '../types';

/** The closed host vocabulary for a recipient-specific provider suppression. */
type SuppressionReason = InboundEventOf<'email.provider_suppressed'>['reason'];

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

/**
 * The kinds the dispatcher acts on. Everything else Emailit sends — click/open
 * tracking, scheduling, inbound receipts, and any event name Emailit adds later
 * — is acknowledged and dropped: first-party tracking stays authoritative and
 * scheduling/receiving do not move Owlat's outbound Send lifecycle. Same
 * posture as the Resend and Mandrill adapters' default branches.
 */
const ACTIONABLE_EVENT_TYPES: ReadonlySet<EmailitEventType> = new Set([
	'email.accepted',
	'email.attempted',
	'email.bounced',
	'email.complained',
	'email.delivered',
	'email.failed',
	'email.rejected',
	'email.suppressed',
]);

/**
 * Free-text `status` naming a mailbox that does not exist. This is the ONE
 * suppression reason `providerSuppression` turns into a hard `bounced` block
 * (every other reason lands a reversible `manual` one), so the list stays
 * narrow: text that merely reports a refusal must not blocklist permanently.
 */
const INVALID_RECIPIENT_STATUS =
	/invalid[ _-]?(?:recipient|address|email|mailbox)|does not exist|non-?existent|no such (?:user|mailbox|address)|user unknown|unknown (?:user|recipient)|user not found|mailbox not found|no mailbox/i;

/** Free-text `status` naming an explicit refusal of the address by the receiver. */
const REJECTED_RECIPIENT_STATUS = /reject|refus|denied/i;

/** Free-text `status` reporting the recipient marked the mail as spam. */
const SPAM_COMPLAINT_STATUS = /spam|complain|abuse|feedback[ _-]?loop|\bfbl\b/i;

/** Free-text `status` reporting the recipient unsubscribed at the provider. */
const UNSUBSCRIBED_STATUS = /unsubscrib|opt[ _-]?out/i;

/** Free-text `status` reporting the suppression was caused by bouncing. */
const BOUNCE_STATUS = /bounce/i;

/**
 * Map Emailit's free-text suppression `status` onto the closed host vocabulary.
 * Emailit reports no machine cause, so the text is the only signal about WHY an
 * address was suppressed; unrecognized text falls back to the conservative
 * `recipient_blacklisted`. Order is most-specific first: nonexistent-mailbox
 * phrasings outrank the bounce word they often ride in on, and a bounce-caused
 * suppression borrows the shared hard/soft classifier so the block it lands
 * matches the one the bounce event itself would have landed.
 */
function suppressionReason(status: string | undefined): SuppressionReason {
	const text = status ?? '';
	if (INVALID_RECIPIENT_STATUS.test(text)) return 'invalid_recipient';
	if (SPAM_COMPLAINT_STATUS.test(text)) return 'spam_complaint';
	if (UNSUBSCRIBED_STATUS.test(text)) return 'unsubscribed';
	if (BOUNCE_STATUS.test(text)) {
		// An explicit hard/soft label is the provider stating the disposition;
		// only unlabeled text falls to the shared cause classifier (soft default).
		if (/soft/i.test(text)) return 'soft_bounce';
		if (/hard/i.test(text)) return 'hard_bounce';
		return classifyBounceMessage(text) === 'hard' ? 'hard_bounce' : 'soft_bounce';
	}
	if (REJECTED_RECIPIENT_STATUS.test(text)) return 'recipient_rejected';
	return 'recipient_blacklisted';
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
		// Drop the kinds we never dispatch BEFORE parsing the timestamp: an
		// unparseable timestamp must fail closed only for the events that move
		// the Send lifecycle. Failing a click or a receipt with a 400 would risk
		// Emailit disabling the endpoint over telemetry we discard anyway.
		if (!ACTIONABLE_EVENT_TYPES.has(payload.type)) return null;
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
			case 'email.bounced': {
				// Emailit reports one free-text `status` and no hard/soft flag, so the
				// text is classified by the shared soft-default classifier the Resend
				// adapter and the MTA bounce engine use. Defaulting to `hard` would
				// permanently blocklist a recipient on any transient failure.
				const bounceMessage = object.status ?? '';
				return {
					kind: 'email.bounced',
					providerMessageId,
					at,
					providerType,
					bounceType: classifyBounceMessage(bounceMessage),
					...(bounceMessage ? { bounceMessage } : {}),
				};
			}
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
					reason: suppressionReason(object.status),
				};
			default:
				// Unreachable: the ignorable kinds returned above, before the
				// timestamp was parsed. See ACTIONABLE_EVENT_TYPES.
				return null;
		}
	},
};
