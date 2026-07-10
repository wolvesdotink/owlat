import { describe, it, expect } from 'vitest';
import { smtpSendProvider, smtpReplyCodeToErrorCode } from '../index';
import { EmailErrorCode, isRetryableErrorCode } from '../../types';

describe('smtpReplyCodeToErrorCode — SMTP reply code taxonomy (RFC 5321 §4.2)', () => {
	const cases: Array<[number, string, EmailErrorCode]> = [
		// 4xx — transient, retryable server errors.
		[421, 'Service not available', EmailErrorCode.SERVER_ERROR],
		[450, 'Requested mail action not taken: mailbox unavailable', EmailErrorCode.SERVER_ERROR],
		[451, 'Requested action aborted: local error', EmailErrorCode.SERVER_ERROR],
		[452, 'Insufficient system storage', EmailErrorCode.SERVER_ERROR],
		// 4xx that names a rate limit → RATE_LIMIT (still retryable).
		[421, '4.7.0 Too many messages, slow down', EmailErrorCode.RATE_LIMIT],
		[450, 'rate limit exceeded for this sender', EmailErrorCode.RATE_LIMIT],
		// 5xx — permanent.
		[530, '5.7.0 Authentication required', EmailErrorCode.AUTH_FAILED],
		[535, '5.7.8 Authentication credentials invalid', EmailErrorCode.AUTH_FAILED],
		[550, '5.1.1 Recipient address rejected: User unknown', EmailErrorCode.INVALID_RECIPIENT],
		[551, 'User not local', EmailErrorCode.INVALID_RECIPIENT],
		[553, 'Mailbox name not allowed', EmailErrorCode.INVALID_RECIPIENT],
		[552, 'Message size exceeds fixed maximum', EmailErrorCode.CONTENT_REJECTED],
		[554, '5.7.1 Message rejected as spam', EmailErrorCode.CONTENT_REJECTED],
		// Unmapped 5xx falls back to a content reject rather than retrying.
		[556, 'Domain does not accept mail', EmailErrorCode.CONTENT_REJECTED],
	];

	it.each(cases)('reply code %i (%s) → %s', (code, message, expected) => {
		expect(smtpReplyCodeToErrorCode(code, message)).toBe(expected);
	});

	it('returns undefined for a non-reply-code (2xx/3xx) so the caller parses text', () => {
		expect(smtpReplyCodeToErrorCode(250, 'OK')).toBeUndefined();
		expect(smtpReplyCodeToErrorCode(354, 'Start mail input')).toBeUndefined();
	});

	it('classifies 4xx as retryable and 5xx as terminal', () => {
		expect(isRetryableErrorCode(smtpReplyCodeToErrorCode(451, 'temporary')!)).toBe(true);
		expect(isRetryableErrorCode(smtpReplyCodeToErrorCode(550, 'rejected')!)).toBe(false);
	});
});

describe('smtpSendProvider.categorizeError — nodemailer string codes + text', () => {
	const provider = smtpSendProvider;

	it('maps the numeric reply code when present (authoritative)', () => {
		expect(provider.categorizeError('EMESSAGE: rejected', 550)).toBe(
			EmailErrorCode.INVALID_RECIPIENT
		);
		expect(provider.categorizeError('anything', 452)).toBe(EmailErrorCode.SERVER_ERROR);
	});

	it('classifies auth failures from the string code', () => {
		expect(provider.categorizeError('EAUTH: Invalid login: 535 auth failed')).toBe(
			EmailErrorCode.AUTH_FAILED
		);
	});

	it('classifies connection failures as retryable server errors', () => {
		expect(provider.categorizeError('ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:587')).toBe(
			EmailErrorCode.SERVER_ERROR
		);
		expect(provider.categorizeError('ESOCKET: Greeting never received')).toBe(
			EmailErrorCode.SERVER_ERROR
		);
	});

	it('classifies rate-limit wording without a reply code', () => {
		expect(provider.categorizeError('EENVELOPE: too many messages this hour')).toBe(
			EmailErrorCode.RATE_LIMIT
		);
	});

	it('classifies envelope/recipient problems', () => {
		expect(provider.categorizeError('EENVELOPE: No recipients defined')).toBe(
			EmailErrorCode.INVALID_RECIPIENT
		);
	});

	it('classifies content rejection', () => {
		expect(provider.categorizeError('EMESSAGE: message content flagged as spam')).toBe(
			EmailErrorCode.CONTENT_REJECTED
		);
	});

	it('defaults to UNKNOWN for empty / unrecognized input', () => {
		expect(provider.categorizeError('')).toBe(EmailErrorCode.UNKNOWN);
		expect(provider.categorizeError('something inscrutable')).toBe(EmailErrorCode.UNKNOWN);
	});

	it('declares a non-empty retry schedule and the smtp kind', () => {
		expect(provider.kind).toBe('smtp');
		expect(provider.retryDelays.length).toBeGreaterThan(0);
	});
});
