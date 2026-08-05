/**
 * D4 — a Mandrill timeout is AMBIGUOUS, and therefore TERMINAL.
 *
 * Resend can let a timeout stay retryable because it takes an `Idempotency-Key`
 * and de-dupes a surviving retry server-side. Mandrill's API has no such
 * surface: once `send-raw` is on the wire, a lost response may sit on top of a
 * message that was accepted AND delivered. Re-sending would put a second copy in
 * the recipient's inbox — the one failure mode a send path must never have.
 *
 * So the adapter takes the SES posture: `AMBIGUOUS_TIMEOUT` (not in the
 * retryable set) plus `acceptanceUnknown: true`, which tells the governed
 * boundary the outcome is genuinely undecided rather than a definite failure.
 * The Mandrill `send` webhook event resolves the ambiguity later (P2.1).
 *
 * The load-bearing assertion in this file is the attempt COUNT: exactly one
 * network call, even through the full dispatch loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mandrillSendProvider, _resetMandrillConfigCacheForTests } from '../index';
import { isAmbiguousMandrillTimeout, MANDRILL_SEND_TIMEOUT_MESSAGE } from '../errors';
import { sendProviderDispatch } from '../../dispatch';
import { EmailErrorCode, isRetryableErrorCode } from '../../types';
import { resolveSendTransport, _resetSendTransportCacheForTests } from '../../transports';

const originalFetch = global.fetch;

const params = {
	to: 'to@example.com',
	from: 'from@acme.com',
	subject: 'hi',
	html: '<p>hi</p>',
};

function fakeCtx(): Parameters<typeof sendProviderDispatch>[0] {
	return {
		runMutation: vi.fn(async () => true),
		scheduler: { runAfter: vi.fn(async () => undefined) },
	} as unknown as Parameters<typeof sendProviderDispatch>[0];
}

beforeEach(() => {
	_resetSendTransportCacheForTests();
	_resetMandrillConfigCacheForTests();
	vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetMandrillConfigCacheForTests();
});

describe('isAmbiguousMandrillTimeout', () => {
	it('recognises our own withTimeout sentinel', () => {
		expect(isAmbiguousMandrillTimeout(undefined, MANDRILL_SEND_TIMEOUT_MESSAGE)).toBe(true);
	});

	it.each(['TimeoutError', 'AbortError', 'timeouterror', 'aborterror'])(
		'recognises the runtime error name %s',
		(name) => {
			expect(isAmbiguousMandrillTimeout(name, 'whatever')).toBe(true);
		}
	);

	it.each(['socket timed out', 'request timeout', 'ETIMEDOUT', 'socket hang up'])(
		'recognises the message text %j',
		(message) => {
			expect(isAmbiguousMandrillTimeout(undefined, message)).toBe(true);
		}
	);

	it('does NOT swallow a definite refusal that never reached acceptance', () => {
		// Over-broadening this predicate would make genuinely retryable failures
		// terminal and silently drop mail — the opposite failure to double-delivery,
		// and just as bad.
		expect(isAmbiguousMandrillTimeout('TypeError', 'connect ECONNREFUSED 1.2.3.4:443')).toBe(false);
		expect(isAmbiguousMandrillTimeout(undefined, 'ServiceUnavailable: try again')).toBe(false);
	});
});

describe('the adapter posture on a timed-out send', () => {
	it('returns AMBIGUOUS_TIMEOUT with acceptanceUnknown, not a plain failure', async () => {
		const timeout = new Error('socket timed out');
		timeout.name = 'TimeoutError';
		global.fetch = vi.fn().mockRejectedValue(timeout) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(resolveSendTransport('mandrill'), params);

		expect(result).toEqual({
			success: false,
			errorMessage: 'socket timed out',
			errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			acceptanceUnknown: true,
		});
	});

	it('AMBIGUOUS_TIMEOUT is not in the retryable set', () => {
		expect(isRetryableErrorCode(EmailErrorCode.AMBIGUOUS_TIMEOUT)).toBe(false);
	});

	it('aborts the in-flight request so it cannot deliver after we reported a timeout', async () => {
		// Promise.race cannot cancel its losing branch, so the adapter must abort the
		// fetch itself — otherwise the request continues in the background and
		// delivers a message we already recorded as un-sent.
		let captured: AbortSignal | undefined;
		global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
			captured = init.signal ?? undefined;
			const timeout = new Error(MANDRILL_SEND_TIMEOUT_MESSAGE);
			return Promise.reject(timeout);
		}) as unknown as typeof fetch;

		await mandrillSendProvider.sendEmail(resolveSendTransport('mandrill'), params);

		expect(captured).toBeDefined();
		expect(captured?.aborted).toBe(true);
	});

	it('an explicit 503 (NOT accepted) stays the retryable SERVER_ERROR', async () => {
		// Regression guard against over-broadening: only ambiguity is terminal. A
		// real 5xx means Mandrill did not take the message, so re-sending is safe
		// and correct.
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: 'error', name: 'ServiceUnavailable' }), {
				status: 503,
			})
		) as unknown as typeof fetch;

		const result = await mandrillSendProvider.sendEmail(resolveSendTransport('mandrill'), params);

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.errorCode).toBe(EmailErrorCode.SERVER_ERROR);
			expect(result.acceptanceUnknown).toBeUndefined();
		}
		expect(isRetryableErrorCode(EmailErrorCode.SERVER_ERROR)).toBe(true);
	});
});

describe('the dispatch loop never re-sends after a timeout', () => {
	it('makes EXACTLY ONE Mandrill call — a second would double-deliver', async () => {
		const timeout = new Error('socket timed out');
		timeout.name = 'TimeoutError';
		const fetchSpy = vi.fn().mockRejectedValue(timeout);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const dispatched = await sendProviderDispatch(fakeCtx(), 'mandrill', params);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(dispatched.attempts).toBe(1);
		expect(dispatched.providerType).toBe('mandrill');
		expect(dispatched.result.success).toBe(false);
		if (!dispatched.result.success) {
			expect(dispatched.result.errorCode).toBe(EmailErrorCode.AMBIGUOUS_TIMEOUT);
			expect(dispatched.result.acceptanceUnknown).toBe(true);
		}
	});

	it('preserves acceptanceUnknown all the way out of the dispatch result', async () => {
		const timeout = new Error(MANDRILL_SEND_TIMEOUT_MESSAGE);
		global.fetch = vi.fn().mockRejectedValue(timeout) as unknown as typeof fetch;

		const dispatched = await sendProviderDispatch(fakeCtx(), 'mandrill', params);

		expect(dispatched.result).toMatchObject({
			success: false,
			errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			acceptanceUnknown: true,
		});
	});
});
