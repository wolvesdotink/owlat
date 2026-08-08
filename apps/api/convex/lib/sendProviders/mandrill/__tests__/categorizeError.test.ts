/**
 * Mandrill error taxonomy (plan §4).
 *
 * The classification decides RETRY vs. TERMINAL, so each row here is a real
 * operational consequence rather than a label: RATE_LIMIT and SERVER_ERROR are
 * re-sent by the dispatch loop, everything else stops. Two Mandrill quirks make
 * this more than a lookup table and both get their own block below:
 *
 *  - Mandrill reports the hourly quota and a bad API key as `GeneralError` /
 *    `Invalid_Key` with an HTTP **500**, so a naive status-first classifier
 *    would re-send into an exhausted quota and retry a dead credential.
 *  - An HTTP 200 can still be a failed send: the per-recipient array carries
 *    `rejected` / `invalid` entries with a `reject_reason`.
 */

import { describe, it, expect } from 'vitest';
import { mandrillSendProvider } from '../index';
import { parseRetryAfterMs } from '../errors';
import { EmailErrorCode, isRetryableErrorCode } from '../../types';

const categorize = (message: string, status?: number): EmailErrorCode =>
	mandrillSendProvider.categorizeError(message, status);

describe('per-recipient reject reasons', () => {
	it.each([
		// Recipient-side — the address is unmailable or on Mandrill's reject list.
		// P2.2 mirrors the reject-list ones into `blockedEmails`.
		['rejected: hard-bounce', EmailErrorCode.INVALID_RECIPIENT],
		['rejected: soft-bounce', EmailErrorCode.INVALID_RECIPIENT],
		['rejected: invalid', EmailErrorCode.INVALID_RECIPIENT],
		['rejected: unsub', EmailErrorCode.INVALID_RECIPIENT],
		['rejected: custom', EmailErrorCode.INVALID_RECIPIENT],
		// Sender-side — the From domain is not set up in the Mandrill account.
		['rejected: unsigned', EmailErrorCode.INVALID_SENDER],
		['rejected: invalid-sender', EmailErrorCode.INVALID_SENDER],
		// Content / policy.
		['rejected: spam', EmailErrorCode.CONTENT_REJECTED],
		['rejected: rule', EmailErrorCode.CONTENT_REJECTED],
		// A test key's allowance is a rate limit in every sense the loop cares about.
		['rejected: test-mode-limit', EmailErrorCode.RATE_LIMIT],
		// `invalid` carries no reason of its own — the status alone decides it.
		['invalid: ', EmailErrorCode.INVALID_RECIPIENT],
		['invalid: nope@', EmailErrorCode.INVALID_RECIPIENT],
	])('%s → %s', (message, expected) => {
		expect(categorize(message)).toBe(expected);
	});

	it('is case-insensitive about the status and the reason', () => {
		expect(categorize('REJECTED: Hard-Bounce')).toBe(EmailErrorCode.INVALID_RECIPIENT);
		expect(categorize('Rejected: UNSIGNED')).toBe(EmailErrorCode.INVALID_SENDER);
	});

	it('every terminal reject reason is genuinely terminal', () => {
		for (const message of [
			'rejected: hard-bounce',
			'rejected: unsigned',
			'rejected: spam',
			'invalid: nope@',
		]) {
			expect(isRetryableErrorCode(categorize(message))).toBe(false);
		}
	});

	it('falls through to the text taxonomy for a reason Mandrill adds later', () => {
		// An unlisted reason is NOT silently bucketed; it re-enters the text rules,
		// so a future `rejected: spam-complaint` still reads as content.
		expect(categorize('rejected: spam-complaint')).toBe(EmailErrorCode.CONTENT_REJECTED);
		expect(categorize('rejected: something-nobody-has-seen')).toBe(EmailErrorCode.UNKNOWN);
	});
});

describe('rate limiting beats the HTTP status', () => {
	it('classifies the hourly-quota GeneralError as RATE_LIMIT despite its 500', () => {
		// The whole point: a 500 would otherwise become a retryable SERVER_ERROR and
		// re-send straight back into the exhausted quota on the WRONG backoff.
		const message =
			'GeneralError: You have exceeded your hourly sending quota. Please try again later.';
		expect(categorize(message, 500)).toBe(EmailErrorCode.RATE_LIMIT);
	});

	it.each([
		'GeneralError: hourly quota exceeded',
		'GeneralError: sending quota reached',
		'rate limit exceeded',
		'Too many requests',
		'Your account is being throttled',
		'GeneralError: message backlog is too large',
	])('%s → RATE_LIMIT', (message) => {
		expect(categorize(message)).toBe(EmailErrorCode.RATE_LIMIT);
	});

	it('classifies a plain HTTP 429 as RATE_LIMIT', () => {
		expect(categorize('slow down', 429)).toBe(EmailErrorCode.RATE_LIMIT);
	});

	it('RATE_LIMIT stays retryable', () => {
		expect(isRetryableErrorCode(EmailErrorCode.RATE_LIMIT)).toBe(true);
	});
});

describe('credential failures beat the HTTP status too', () => {
	it.each([
		'Invalid_Key: Invalid API key',
		'ValidationError: invalid api key supplied',
		'Unknown_Subaccount: no such subaccount',
		'PaymentRequired: account is not in good standing',
	])('%s → AUTH_FAILED even on a 500', (message) => {
		// Retrying a dead credential three times just burns the deadline.
		expect(categorize(message, 500)).toBe(EmailErrorCode.AUTH_FAILED);
		expect(isRetryableErrorCode(categorize(message, 500))).toBe(false);
	});

	it('classifies an HTTP 401/403 as AUTH_FAILED', () => {
		expect(categorize('nope', 401)).toBe(EmailErrorCode.AUTH_FAILED);
		expect(categorize('nope', 403)).toBe(EmailErrorCode.AUTH_FAILED);
	});
});

describe('server errors', () => {
	it.each([500, 502, 503, 504])('HTTP %s → SERVER_ERROR', (status) => {
		expect(categorize('upstream is unhappy', status)).toBe(EmailErrorCode.SERVER_ERROR);
	});

	it.each([
		'ServiceUnavailable: try again',
		'GeneralError: an internal error occurred',
		'connect ECONNREFUSED 1.2.3.4:443',
	])('%s → SERVER_ERROR', (message) => {
		expect(categorize(message)).toBe(EmailErrorCode.SERVER_ERROR);
	});

	it('SERVER_ERROR stays retryable', () => {
		expect(isRetryableErrorCode(categorize('boom', 503))).toBe(true);
	});
});

describe('API-level validation errors route by what they name', () => {
	it.each([
		['ValidationError: from_email is not a verified sending domain', EmailErrorCode.INVALID_SENDER],
		['ValidationError: sender domain is unsigned', EmailErrorCode.INVALID_SENDER],
		['ValidationError: content rejected by an account rule', EmailErrorCode.CONTENT_REJECTED],
		['ValidationError: message looks like spam', EmailErrorCode.CONTENT_REJECTED],
		['ValidationError: recipient address is malformed', EmailErrorCode.INVALID_RECIPIENT],
		['ValidationError: address is on the reject list', EmailErrorCode.INVALID_RECIPIENT],
	])('%s → %s', (message, expected) => {
		expect(categorize(message)).toBe(expected);
	});

	it('falls through to UNKNOWN for anything unrecognised', () => {
		expect(categorize('')).toBe(EmailErrorCode.UNKNOWN);
		expect(categorize('mystery error')).toBe(EmailErrorCode.UNKNOWN);
		expect(isRetryableErrorCode(EmailErrorCode.UNKNOWN)).toBe(false);
	});
});

describe('parseRetryAfterMs', () => {
	it('reads delta-seconds and converts to milliseconds', () => {
		expect(parseRetryAfterMs('30')).toBe(30_000);
		expect(parseRetryAfterMs(' 45 ')).toBe(45_000);
	});

	it('clamps into [1s, 1h] so a hostile header cannot park or busy-loop a Send', () => {
		expect(parseRetryAfterMs('0.1')).toBe(1_000);
		expect(parseRetryAfterMs('999999')).toBe(3_600_000);
	});

	it('ignores an absent, non-numeric or non-positive value rather than guessing', () => {
		// An HTTP-date form would need a trusted clock delta to mean anything, so it
		// is declined rather than mis-parsed into an arbitrary wait.
		expect(parseRetryAfterMs(null)).toBeUndefined();
		expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
		expect(parseRetryAfterMs('')).toBeUndefined();
		expect(parseRetryAfterMs('-5')).toBeUndefined();
	});
});
