import { describe, it, expect } from 'vitest';
import { smtpSendProvider, smtpReplyCodeToErrorCode, classifySmtpError } from '../index';
import { EmailErrorCode, isRetryableErrorCode } from '../../types';
import type { SmtpPhase } from '@owlat/smtp-client';

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

describe('smtpSendProvider.categorizeError — string codes + reply text', () => {
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

describe('classifySmtpError — structured (phase + reply code) catch-side classification', () => {
	type Input = Parameters<typeof classifySmtpError>[0];

	// Case-by-case successors to the pre-refactor old-library-shaped table. Each
	// row asserts the SAME EmailErrorCode the old string/command classifier
	// produced, now driven off the structured SmtpError discriminants (phase +
	// replyCode) with zero message-text sniffing. The decision table — and above
	// all the double-delivery boundary — is provably unchanged.
	const cases: Array<[string, Input, EmailErrorCode]> = [
		// (old: 421/DATA "timeout exceeded" → SERVER_ERROR). A definitive 4xx reply
		// is the server's verdict — the message was NOT accepted, so there is no
		// double-delivery ambiguity. The reply code is authoritative even at
		// data-final, giving a retryable SERVER_ERROR, never AMBIGUOUS_TIMEOUT.
		[
			'421 reply at data-final is a retryable server error, not ambiguous',
			{ phase: 'data-final', replyCode: 421, message: '4.4.2 Error: timeout exceeded' },
			EmailErrorCode.SERVER_ERROR,
		],
		// (old: withTimeout sentinel, no reply → AMBIGUOUS). A data-final failure
		// with no reply is the genuinely ambiguous region — the 250 may be lost.
		[
			'data-final failure with no reply code is AMBIGUOUS_TIMEOUT',
			{ phase: 'data-final', message: 'SMTP relay send timed out' },
			EmailErrorCode.AMBIGUOUS_TIMEOUT,
		],
		// (old: socket ETIMEDOUT, no reply → AMBIGUOUS). A read timeout awaiting the
		// message acknowledgement is ambiguous for the same reason.
		[
			'data-final read timeout with no reply code is AMBIGUOUS_TIMEOUT',
			{ phase: 'data-final', message: 'Connection timed out' },
			EmailErrorCode.AMBIGUOUS_TIMEOUT,
		],
		// (old: CONN ETIMEDOUT → SERVER_ERROR). A connect-phase failure never
		// reached the wire, so it is always retryable — even a connect timeout.
		// The structured phase now tells connect-timeout from data-timeout apart,
		// so a connect timeout is correctly retryable rather than lumped ambiguous.
		[
			'connect-phase timeout is a retryable server error',
			{ phase: 'connect', message: 'Connection timeout' },
			EmailErrorCode.SERVER_ERROR,
		],
		// (old: CONN "Greeting never received" → SERVER_ERROR).
		[
			'greeting-phase failure is a retryable server error',
			{ phase: 'greeting', message: 'greeting never received' },
			EmailErrorCode.SERVER_ERROR,
		],
		// (old: DATA connection loss → AMBIGUOUS). A drop during DATA may mean the
		// final dot was sent and the 250 lost — the ambiguous, never-retried region.
		[
			'data-phase connection loss is AMBIGUOUS_TIMEOUT (final dot may be on the wire)',
			{ phase: 'data', message: 'Connection closed unexpectedly' },
			EmailErrorCode.AMBIGUOUS_TIMEOUT,
		],
		// (old: DATA socket hang up → AMBIGUOUS).
		[
			'data-final socket hang up is AMBIGUOUS_TIMEOUT',
			{ phase: 'data-final', message: 'socket hang up' },
			EmailErrorCode.AMBIGUOUS_TIMEOUT,
		],
		// (old: RCPT connection loss → SERVER_ERROR). Pre-DATA drops leave the
		// server with an incomplete transaction it discards, so they stay retryable.
		[
			'rcpt-phase failure stays a retryable server error',
			{ phase: 'rcpt', message: 'Connection closed unexpectedly' },
			EmailErrorCode.SERVER_ERROR,
		],
		// (old: MAIL connection loss → SERVER_ERROR).
		[
			'mail-phase failure stays a retryable server error',
			{ phase: 'mail', message: 'Connection closed' },
			EmailErrorCode.SERVER_ERROR,
		],
		// Newly-distinguishable pre-DATA phases the string classifier could not
		// name — both pre-acceptance, so retryable server errors.
		[
			'ehlo-phase failure is a retryable server error',
			{ phase: 'ehlo', message: 'EHLO rejected' },
			EmailErrorCode.SERVER_ERROR,
		],
		[
			'starttls-phase failure is a retryable server error',
			{ phase: 'starttls', message: 'STARTTLS not offered' },
			EmailErrorCode.SERVER_ERROR,
		],
		// An AUTH rejection with no reply code is a credential/handshake problem.
		[
			'auth-phase failure with no reply code is AUTH_FAILED',
			{ phase: 'auth', message: 'authentication refused' },
			EmailErrorCode.AUTH_FAILED,
		],
		// (old: 550/RCPT reply → INVALID_RECIPIENT). Reply-code path still
		// authoritative through the classifier.
		[
			'550 reply → permanent INVALID_RECIPIENT',
			{ phase: 'rcpt', replyCode: 550, message: '5.1.1 User unknown' },
			EmailErrorCode.INVALID_RECIPIENT,
		],
		// (old: 535 reply → AUTH_FAILED).
		[
			'535 reply → permanent AUTH_FAILED',
			{ phase: 'auth', replyCode: 535, message: '5.7.8 auth failed' },
			EmailErrorCode.AUTH_FAILED,
		],
	];

	it.each(cases)('%s', (_name, input, expected) => {
		expect(classifySmtpError(input)).toBe(expected);
	});

	// The double-delivery invariant, asserted directly (the reviewer's focus): a
	// post-DATA failure is auto-retried ONLY when the server itself returned a
	// reply code (an explicit verdict that the message was rejected, not
	// accepted). With NO reply, every data/data-final phase is terminal.
	const postDataPhases: SmtpPhase[] = ['data', 'data-final'];
	it.each(postDataPhases)(
		'phase %s with no reply is AMBIGUOUS_TIMEOUT and never retryable',
		(phase) => {
			const code = classifySmtpError({ phase, message: 'dropped' });
			expect(code).toBe(EmailErrorCode.AMBIGUOUS_TIMEOUT);
			expect(isRetryableErrorCode(code)).toBe(false);
		}
	);

	it('a post-DATA 5xx reply is a permanent (non-retryable) reject, not a retry', () => {
		const code = classifySmtpError({ phase: 'data-final', replyCode: 554, message: 'rejected' });
		expect(code).toBe(EmailErrorCode.CONTENT_REJECTED);
		expect(isRetryableErrorCode(code)).toBe(false);
	});

	it('a post-DATA 4xx reply is a retryable server verdict (message provably not accepted)', () => {
		// Safe to retry: a 4xx acknowledging the body means the server explicitly
		// declined it, so no message was delivered and no double-send can occur.
		const code = classifySmtpError({ phase: 'data-final', replyCode: 451, message: 'try later' });
		expect(code).toBe(EmailErrorCode.SERVER_ERROR);
		expect(isRetryableErrorCode(code)).toBe(true);
	});

	// X3 — SMTPUTF8 / EAI fail-closed. A client-side refusal (no reply code) whose
	// `clientRefusal` discriminant is `smtputf8-unavailable` maps to its own
	// distinct, non-retryable code rather than the phase-`mail` SERVER_ERROR default.
	it('a phase-mail SMTPUTF8 client refusal is a distinct, non-retryable code', () => {
		const code = classifySmtpError({
			phase: 'mail',
			message: 'server does not advertise SMTPUTF8',
			clientRefusal: 'smtputf8-unavailable',
		});
		expect(code).toBe(EmailErrorCode.SMTPUTF8_UNSUPPORTED);
		expect(isRetryableErrorCode(code)).toBe(false);
	});

	it('the clientRefusal discriminant overrides the phase-mail default even with no reply code', () => {
		// Without the discriminant, a reply-less phase-mail error is a retryable
		// SERVER_ERROR — proving the SMTPUTF8 refusal is classified by its structured
		// cause, not by phase alone.
		expect(classifySmtpError({ phase: 'mail', message: 'x' })).toBe(EmailErrorCode.SERVER_ERROR);
	});
});
