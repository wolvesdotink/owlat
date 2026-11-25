/**
 * Why a send did not arrive, as a sentence a person can act on.
 *
 * A send records a stable `errorCode` (and, for a bounce, its class) next to
 * the provider's own English text. The report and the per-send page show the
 * sentence for the code's class and keep the provider text one click away.
 * A class the system already retries or takes care of says so instead of
 * asking for a step nobody has to take.
 *
 * Fix links reuse the campaign refusal targets, so a page that fixes a
 * refused send and a failed one is the same page under the same label.
 */
import { refusalFixLink, type RefusalFixLink } from '~/lib/campaignRefusal';

export const SEND_FAILURE_CLASSES = [
	'credentials',
	'transportMissing',
	'sender',
	'recipientRefused',
	'addressUnsupported',
	'blocklisted',
	'unsubscribed',
	'contactDeleted',
	'automationPaused',
	'content',
	'providerRefused',
	'providerUnavailable',
	'deliveryHold',
	'mailServerUnreachable',
	'sendingSuspended',
	'deferredTooLong',
	'unconfirmed',
	'noFeedback',
	'hardBounce',
	'softBounce',
	'unknown',
] as const;

export type SendFailureClass = (typeof SEND_FAILURE_CLASSES)[number];

/**
 * Every code a campaign or transactional send can fail with that says more
 * than "it failed". The send pipeline writes them (provider adapters, the send
 * completion, the routing re-entry and the lost-send sweep); a code missing
 * here, `WORKPOOL_FAILED` among them, reads as `unknown` with its raw text.
 */
export const SEND_FAILURE_CODE_CLASSES: Readonly<Record<string, SendFailureClass>> = {
	AUTH_FAILED: 'credentials',
	CONFIGURATION: 'transportMissing',
	SEND_TRANSPORT_UNRESOLVED: 'transportMissing',
	INVALID_SENDER: 'sender',
	MANDRILL_REJECT_INVALID_SENDER: 'sender',
	INVALID_RECIPIENT: 'recipientRefused',
	SMTPUTF8_UNSUPPORTED: 'addressUnsupported',
	RECIPIENT_SUPPRESSED: 'blocklisted',
	RECIPIENT_UNSUBSCRIBED: 'unsubscribed',
	// Left the topic an automation belongs to: an unsubscribe, from that topic.
	RECIPIENT_LEFT_TOPIC: 'unsubscribed',
	CONTACT_DELETED: 'contactDeleted',
	// The automation was paused after it queued the email: withdrawn, not failed.
	AUTOMATION_PAUSED: 'automationPaused',
	CONTENT_REJECTED: 'content',
	PROVIDER_REJECTED: 'providerRefused',
	PROVIDER_FAILED: 'providerRefused',
	RATE_LIMIT: 'providerUnavailable',
	SERVER_ERROR: 'providerUnavailable',
	DELIVERY_HOLD_EXPIRED: 'deliveryHold',
	MTA_UNREACHABLE: 'mailServerUnreachable',
	SENDING_SUSPENDED: 'sendingSuspended',
	DELIVERY_DEADLINE_EXPIRED: 'deferredTooLong',
	ROUTING_RETRY_LIMIT_EXHAUSTED: 'deferredTooLong',
	ROUTING_RETRY_EXHAUSTED: 'deferredTooLong',
	ROUTING_DEFERRED: 'deferredTooLong',
	ROUTING_LEASE_UNREADABLE: 'deferredTooLong',
	AMBIGUOUS_TIMEOUT: 'unconfirmed',
	PROVIDER_ACCEPTANCE_UNCONFIRMED: 'unconfirmed',
	MTA_ACCEPTANCE_UNCONFIRMED: 'unconfirmed',
	SEND_COMPLETION_LOST: 'unconfirmed',
	SEND_COMPLETION_UNRECOVERABLE: 'unconfirmed',
	WORKER_RESULT_MALFORMED: 'unconfirmed',
	SEND_FEEDBACK_UNAVAILABLE: 'noFeedback',
	// Sends written before `bounceType` existed kept the class here.
	hard_bounce: 'hardBounce',
	soft_bounce: 'softBounce',
};

/** Mandrill names each reject reason after this prefix (`MANDRILL_REJECT_SPAM`, ...). */
const MANDRILL_REJECT_PREFIX = 'MANDRILL_REJECT';

/** The class of a failed send's code; `unknown` for a code this build does not know. */
export function failureClassOfCode(code: string | null | undefined): SendFailureClass {
	if (!code) return 'unknown';
	// Own keys only: a provider code such as `constructor` is not a class.
	if (Object.hasOwn(SEND_FAILURE_CODE_CLASSES, code)) return SEND_FAILURE_CODE_CLASSES[code]!;
	if (code.startsWith(MANDRILL_REJECT_PREFIX)) return 'providerRefused';
	return 'unknown';
}

/** The class of a send: a bounce by its type, anything else by its code. */
export function failureClassOfSend(send: {
	status?: string;
	bounceType?: 'hard' | 'soft' | null;
	errorCode?: string | null;
}): SendFailureClass {
	if (send.status === 'bounced' || send.bounceType) {
		if (send.bounceType === 'hard') return 'hardBounce';
		if (send.bounceType === 'soft') return 'softBounce';
		return send.errorCode === 'hard_bounce' ? 'hardBounce' : 'softBounce';
	}
	return failureClassOfCode(send.errorCode);
}

/** The catalog key of a class's sentence. */
export function failureReasonKey(failureClass: SendFailureClass): string {
	return `shared.sendFailure.reasons.${failureClass}`;
}

/** The catalog key of a class's short label, for a list row. */
export function failureLabelKey(failureClass: SendFailureClass): string {
	return `shared.sendFailure.labels.${failureClass}`;
}

/**
 * Where a class is fixed. `null` for a class nobody has to fix (the system
 * handled it or already retried) or one only the recipient's side can change:
 * a member is told to ask an admin about every class that has a link.
 */
export function failureFixLink(failureClass: SendFailureClass): RefusalFixLink | null {
	switch (failureClass) {
		case 'credentials':
		case 'transportMissing':
			return refusalFixLink('no_delivery_provider');
		case 'noFeedback':
			return refusalFixLink('no_bounce_feedback');
		case 'sender':
			return refusalFixLink('domain_not_verified');
		case 'sendingSuspended':
			return refusalFixLink('sending_not_allowed');
		case 'mailServerUnreachable':
			return refusalFixLink('mail_server_not_ready');
		case 'deliveryHold':
			return refusalFixLink('delivery_on_hold');
		default:
			return null;
	}
}

/** One reason line of the report: the sends of one class, with one sample of the provider's text. */
export interface FailureReasonGroup {
	failureClass: SendFailureClass;
	count: number;
	/** The code of the reason the provider's text was taken from. */
	errorCode: string | null;
	exampleMessage: string | null;
}

/**
 * Fold the backend's per-code groups into one line per class, largest first:
 * two codes with the same fix read as one reason.
 */
export function groupFailureReasons(
	reasons: readonly {
		errorCode?: string | null;
		bounceType?: 'hard' | 'soft';
		count: number;
		exampleMessage: string | null;
	}[]
): FailureReasonGroup[] {
	const groups = new Map<SendFailureClass, FailureReasonGroup>();
	for (const reason of reasons) {
		const failureClass = reason.bounceType
			? failureClassOfSend({ bounceType: reason.bounceType })
			: failureClassOfCode(reason.errorCode);
		const group = groups.get(failureClass) ?? {
			failureClass,
			count: 0,
			errorCode: reason.errorCode ?? null,
			exampleMessage: reason.exampleMessage,
		};
		group.count += reason.count;
		// The code and the text shown beside it come from the same reason.
		if (group.exampleMessage === null && reason.exampleMessage !== null) {
			group.errorCode = reason.errorCode ?? null;
			group.exampleMessage = reason.exampleMessage;
		}
		groups.set(failureClass, group);
	}
	return [...groups.values()].sort((a, b) => b.count - a.count);
}
