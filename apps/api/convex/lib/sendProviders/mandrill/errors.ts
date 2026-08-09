/**
 * Mailchimp Transactional (Mandrill) error taxonomy.
 *
 * Split out of `index.ts` so the classification rules — which decide retry vs.
 * terminal, and which failures are double-delivery-ambiguous — are pinned by
 * table-driven tests rather than living only inside the network path. The
 * module's single public entry point is still `mandrillSendProvider.categorizeError`.
 *
 * Mandrill speaks two different failure dialects and this file covers both:
 *
 *  1. **API-level errors** — a JSON body `{ status: 'error', code, name, message }`
 *     with names like `Invalid_Key`, `ValidationError`, `GeneralError`,
 *     `PaymentRequired`, `Unknown_Subaccount`, `ServiceUnavailable`. The adapter
 *     passes `${name}: ${message}` here, matching the Resend/SES convention.
 *  2. **Per-recipient outcomes** — an HTTP 200 whose body is an array of
 *     `{ email, status, _id, reject_reason }`. A `rejected` / `invalid` entry is
 *     a FAILED send even though the call succeeded, and the adapter passes
 *     `${status}: ${reject_reason}` here.
 */

import { EmailErrorCode, httpStatusToErrorCode } from '../types';

/** Upper bound on a single Mandrill send call. */
export const MANDRILL_SEND_TIMEOUT_MS = 30_000;
export const MANDRILL_SEND_TIMEOUT_MESSAGE = 'Mandrill send timed out';

/**
 * Every `reject_reason` Mandrill documents, mapped to the typed taxonomy.
 *
 * A TABLE rather than substring matching, because these are a closed set of
 * exact tokens and three of them ('invalid', 'custom', 'rule') are words far too
 * generic to sniff for in free text. An unlisted reason falls through to the
 * text taxonomy below rather than being silently bucketed.
 *
 *  - Recipient-side (the address is unmailable or on Mandrill's reject list):
 *    `hard-bounce`, `soft-bounce`, `invalid`, `unsub`, `custom`. All terminal;
 *    P2.2 mirrors the reject-list ones into `blockedEmails`.
 *  - Sender-side: `unsigned` (the From domain is not SPF/DKIM-configured in the
 *    Mandrill account) and `invalid-sender`.
 *  - Content/policy: `spam`, `rule` (an account rejection rule fired).
 *  - Quota: `test-mode-limit` — a test key's send allowance, which is a rate
 *    limit in every sense that matters to the dispatch loop.
 */
const REJECT_REASON_CODES: Readonly<Record<string, EmailErrorCode>> = Object.freeze({
	'hard-bounce': EmailErrorCode.INVALID_RECIPIENT,
	'soft-bounce': EmailErrorCode.INVALID_RECIPIENT,
	invalid: EmailErrorCode.INVALID_RECIPIENT,
	unsub: EmailErrorCode.INVALID_RECIPIENT,
	custom: EmailErrorCode.INVALID_RECIPIENT,
	unsigned: EmailErrorCode.INVALID_SENDER,
	'invalid-sender': EmailErrorCode.INVALID_SENDER,
	spam: EmailErrorCode.CONTENT_REJECTED,
	rule: EmailErrorCode.CONTENT_REJECTED,
	'test-mode-limit': EmailErrorCode.RATE_LIMIT,
});

/**
 * Classify a per-recipient failure the adapter formatted as
 * `"<status>: <reject_reason>"`, or `undefined` when the message is not one.
 *
 * `rejected` and `invalid` are the only two statuses that mean the send failed;
 * `sent`/`queued`/`scheduled` never reach here. `invalid` carries no reason of
 * its own — Mandrill uses it for an address it could not parse — so the status
 * alone decides it.
 */
function perRecipientErrorCode(lowerMessage: string): EmailErrorCode | undefined {
	const match = /^(rejected|invalid)\s*:\s*(.*)$/.exec(lowerMessage);
	if (!match) return undefined;
	const [, status, reason] = match;
	if (status === 'invalid') return EmailErrorCode.INVALID_RECIPIENT;
	return REJECT_REASON_CODES[(reason ?? '').trim()];
}

/**
 * Does this text name Mandrill's hourly-quota / throttling condition?
 *
 * Mandrill reports the hourly quota as a `GeneralError` — with an HTTP 500, not
 * a 429 — so this check has to BEAT the status prelude below or every throttle
 * would be misread as a server fault and retried on the wrong schedule.
 */
function mentionsQuota(lowerMessage: string): boolean {
	return (
		lowerMessage.includes('hourly quota') ||
		lowerMessage.includes('sending quota') ||
		lowerMessage.includes('rate limit') ||
		lowerMessage.includes('rate-limit') ||
		lowerMessage.includes('too many') ||
		lowerMessage.includes('throttl') ||
		lowerMessage.includes('backlog')
	);
}

/**
 * Classify a Mandrill failure. See the module header for the two dialects.
 *
 * Order matters and is deliberate: the quota and credential cases are decided
 * from the TEXT first, because Mandrill returns both of them with a 5xx status
 * that `httpStatusToErrorCode` would otherwise turn into a retryable
 * SERVER_ERROR — re-sending into an exhausted quota, and retrying a bad API key
 * three times, respectively.
 */
export function categorizeMandrillError(message: string, httpStatus?: number): EmailErrorCode {
	const lower = message.toLowerCase();

	const perRecipient = perRecipientErrorCode(lower);
	if (perRecipient !== undefined) return perRecipient;

	if (mentionsQuota(lower)) return EmailErrorCode.RATE_LIMIT;

	if (
		lower.includes('invalid_key') ||
		lower.includes('invalid api key') ||
		lower.includes('unknown_subaccount') ||
		lower.includes('paymentrequired') ||
		lower.includes('unauthorized')
	) {
		return EmailErrorCode.AUTH_FAILED;
	}

	if (httpStatus !== undefined) {
		const byStatus = httpStatusToErrorCode(httpStatus);
		if (byStatus !== undefined) return byStatus;
	}

	if (
		lower.includes('serviceunavailable') ||
		lower.includes('service unavailable') ||
		lower.includes('internal error') ||
		lower.includes('generalerror') ||
		lower.includes('timed out') ||
		lower.includes('econnrefused')
	) {
		return EmailErrorCode.SERVER_ERROR;
	}

	// `ValidationError` is Mandrill's catch-all for a malformed request; the
	// wording says which field, so route it by what it names rather than
	// bucketing every validation failure as one code.
	if (
		lower.includes('unsigned') ||
		lower.includes('invalid-sender') ||
		lower.includes('sender domain') ||
		lower.includes('from_email') ||
		lower.includes('not verified')
	) {
		return EmailErrorCode.INVALID_SENDER;
	}
	if (
		lower.includes('spam') ||
		lower.includes('blocked') ||
		lower.includes('content rejected') ||
		lower.includes('content policy')
	) {
		return EmailErrorCode.CONTENT_REJECTED;
	}
	if (
		lower.includes('reject list') ||
		lower.includes('reject-list') ||
		lower.includes('blacklist') ||
		lower.includes('bounce') ||
		lower.includes('invalid recipient') ||
		lower.includes('recipient')
	) {
		return EmailErrorCode.INVALID_RECIPIENT;
	}

	return EmailErrorCode.UNKNOWN;
}

/**
 * Was this failure an ambiguous post-dispatch timeout (D4)?
 *
 * Mandrill's API has NO idempotency key — unlike Resend, which is why the Resend
 * adapter can let a timeout stay retryable. A timed-out `send-raw` may already
 * have been accepted and delivered, so a retry would double-deliver. Covers our
 * own `withTimeout` sentinel plus the runtime's native abort/timeout signals.
 */
export function isAmbiguousMandrillTimeout(name: string | undefined, message: string): boolean {
	if (message === MANDRILL_SEND_TIMEOUT_MESSAGE) return true;
	const lowerName = (name ?? '').toLowerCase();
	if (lowerName === 'timeouterror' || lowerName === 'aborterror') return true;
	const lower = message.toLowerCase();
	return (
		lower.includes('timed out') ||
		lower.includes('timeout') ||
		lower.includes('etimedout') ||
		lower.includes('socket hang up')
	);
}

export { parseRetryAfterDeltaMs as parseRetryAfterMs } from '../errors';
