/**
 * A post-dispatch timeout is AMBIGUOUS, and every adapter reports it the same way.
 *
 * Once a request is on the wire, a lost response may sit on top of a message the
 * provider already accepted and delivered. The adapters only REPORT that fact as
 * `AMBIGUOUS_TIMEOUT`, through one predicate (`isAmbiguousPostDispatchTimeout`)
 * with their own `withTimeout` sentinel. What it means (retry, or terminal with
 * `acceptanceUnknown`) is decided once, in `sendProviderDispatch`, from the
 * catalog. See `./ambiguousTimeoutPolicy.test.ts` for that half.
 *
 * The load-bearing assertion for Mandrill is the attempt COUNT: exactly one
 * network call, even through the full dispatch loop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESClient } from '@aws-sdk/client-ses';
import { mandrillSendProvider, _resetMandrillConfigCacheForTests } from '../mandrill';
import { MANDRILL_SEND_TIMEOUT_MESSAGE } from '../mandrill/errors';
import { emailitSendProvider } from '../emailit';
import { sesSendProvider, _resetSesClientCacheForTests } from '../ses';
import { resendSendProvider, _resetResendClientCacheForTests } from '../resend';
import { sendProviderDispatch } from '../dispatch';
import { fakeDispatchCtx } from './dispatchFixtures';
import { isAmbiguousPostDispatchTimeout } from '../errors';
import { EmailErrorCode, isRetryableErrorCode } from '../types';
import { resolveSendTransport, _resetSendTransportCacheForTests } from '../transports';

const { resendSendMock } = vi.hoisted(() => ({ resendSendMock: vi.fn() }));
vi.mock('resend', () => ({
	Resend: class {
		emails = { send: resendSendMock };
	},
}));

const originalFetch = global.fetch;

const params = {
	to: 'to@example.com',
	from: 'from@acme.com',
	subject: 'hi',
	html: '<p>hi</p>',
};

beforeEach(() => {
	_resetSendTransportCacheForTests();
	_resetMandrillConfigCacheForTests();
	_resetSesClientCacheForTests();
	_resetResendClientCacheForTests();
	vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
	vi.stubEnv('EMAILIT_API_KEY', 'emailit-test-key');
	vi.stubEnv('RESEND_API_KEY', 're_test_key');
	vi.stubEnv('AWS_SES_REGION', 'us-east-1');
	vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'AKIATEST');
	vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	resendSendMock.mockReset();
	global.fetch = originalFetch;
	_resetSendTransportCacheForTests();
	_resetMandrillConfigCacheForTests();
	_resetSesClientCacheForTests();
	_resetResendClientCacheForTests();
});

describe('isAmbiguousPostDispatchTimeout', () => {
	const sentinel = 'Some provider send timed out';

	it('recognises the adapter’s own withTimeout sentinel', () => {
		expect(isAmbiguousPostDispatchTimeout(undefined, sentinel, sentinel)).toBe(true);
	});

	it('recognises a sentinel that carries no timeout wording of its own', () => {
		expect(isAmbiguousPostDispatchTimeout(undefined, 'deadline hit', 'deadline hit')).toBe(true);
	});

	it.each(['TimeoutError', 'AbortError', 'timeouterror', 'aborterror'])(
		'recognises the runtime error name %s',
		(name) => {
			expect(isAmbiguousPostDispatchTimeout(name, 'whatever', sentinel)).toBe(true);
		}
	);

	it.each(['socket timed out', 'request timeout', 'ETIMEDOUT', 'socket hang up'])(
		'recognises the message text %j',
		(message) => {
			expect(isAmbiguousPostDispatchTimeout(undefined, message, sentinel)).toBe(true);
		}
	);

	it('does NOT swallow a definite refusal that never reached acceptance', () => {
		// Over-broadening this predicate would make genuinely retryable failures
		// terminal and silently drop mail — the opposite failure to double-delivery,
		// and just as bad.
		expect(
			isAmbiguousPostDispatchTimeout('TypeError', 'connect ECONNREFUSED 1.2.3.4:443', sentinel)
		).toBe(false);
		expect(
			isAmbiguousPostDispatchTimeout(undefined, 'ServiceUnavailable: try again', sentinel)
		).toBe(false);
	});

	it('AMBIGUOUS_TIMEOUT is not in the retryable set', () => {
		// Only the dispatch policy may retry it, and only on a dedup kind with a key.
		expect(isRetryableErrorCode(EmailErrorCode.AMBIGUOUS_TIMEOUT)).toBe(false);
	});
});

/** Each adapter's own `withTimeout` sentinel, thrown as the deadline would throw it. */
const SENTINEL_CASES = [
	{
		kind: 'mandrill',
		refusedCode: EmailErrorCode.SERVER_ERROR,
		sentinel: MANDRILL_SEND_TIMEOUT_MESSAGE,
		arm: (error: Error) => {
			global.fetch = vi.fn().mockRejectedValue(error) as unknown as typeof fetch;
		},
		send: () => mandrillSendProvider.sendEmail(resolveSendTransport('mandrill'), params),
	},
	{
		kind: 'emailit',
		refusedCode: EmailErrorCode.SERVER_ERROR,
		sentinel: 'Emailit API call timed out',
		arm: (error: Error) => {
			global.fetch = vi.fn().mockRejectedValue(error) as unknown as typeof fetch;
		},
		send: () => emailitSendProvider.sendEmail(resolveSendTransport('emailit'), params),
	},
	{
		kind: 'ses',
		refusedCode: EmailErrorCode.UNKNOWN,
		sentinel: 'SES send timed out',
		arm: (error: Error) => {
			vi.spyOn(SESClient.prototype, 'send').mockRejectedValue(error as never);
		},
		send: () => sesSendProvider.sendEmail(resolveSendTransport('ses'), params),
	},
	{
		kind: 'resend',
		refusedCode: EmailErrorCode.SERVER_ERROR,
		sentinel: 'Resend API call timed out',
		arm: (error: Error) => {
			resendSendMock.mockRejectedValue(error);
		},
		send: () => resendSendProvider.sendEmail(resolveSendTransport('resend'), params),
	},
] as const;

describe.each(SENTINEL_CASES)(
	'the $kind adapter on a timed-out send',
	({ sentinel, arm, send, refusedCode }) => {
		it('reports its own sentinel as AMBIGUOUS_TIMEOUT and leaves the verdict to dispatch', async () => {
			arm(new Error(sentinel));

			const result = await send();

			// No `acceptanceUnknown` from the adapter: `sendProviderDispatch` adds it
			// from the catalog, so every kind gets it from the same declaration.
			expect(result).toEqual({
				success: false,
				errorMessage: sentinel,
				errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			});
		});

		it('reports a runtime TimeoutError the same way', async () => {
			const timeout = new Error('socket timed out');
			timeout.name = 'TimeoutError';
			arm(timeout);

			const result = await send();

			expect(result).toMatchObject({
				success: false,
				errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			});
		});

		it('keeps a pre-dispatch connection refusal out of the ambiguous bucket', async () => {
			// The adapter's own classifier still decides it (SERVER_ERROR everywhere
			// but SES, whose classifier has never matched ECONNREFUSED).
			const refused = new Error('connect ECONNREFUSED 1.2.3.4:443');
			refused.name = 'TypeError';
			arm(refused);

			const result = await send();

			expect(result).toMatchObject({ success: false, errorCode: refusedCode });
		});
	}
);

describe('Mandrill specifics', () => {
	it('aborts the in-flight request so it cannot deliver after we reported a timeout', async () => {
		// Promise.race cannot cancel its losing branch, so the adapter must abort the
		// fetch itself — otherwise the request continues in the background and
		// delivers a message we already recorded as un-sent.
		let captured: AbortSignal | undefined;
		global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
			captured = init.signal ?? undefined;
			return Promise.reject(new Error(MANDRILL_SEND_TIMEOUT_MESSAGE));
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
	});

	it('the dispatch loop makes EXACTLY ONE Mandrill call and marks the outcome unknown', async () => {
		const timeout = new Error('socket timed out');
		timeout.name = 'TimeoutError';
		const fetchSpy = vi.fn().mockRejectedValue(timeout);
		global.fetch = fetchSpy as unknown as typeof fetch;

		// Even a caller-supplied key does not make Mandrill retry: `send-raw`
		// cannot dedup on it.
		const dispatched = await sendProviderDispatch(fakeDispatchCtx(), 'mandrill', params, {
			idempotencyKey: 'send_1',
		} as never);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(dispatched.attempts).toBe(1);
		expect(dispatched.providerType).toBe('mandrill');
		expect(dispatched.result).toMatchObject({
			success: false,
			errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			acceptanceUnknown: true,
		});
	});
});

describe('Emailit through the dispatch loop', () => {
	it('is no longer retried blind: one call, terminal, acceptance unknown', async () => {
		// Before the shared policy, the Emailit timeout message fell through to
		// `categorizeError` as a retryable SERVER_ERROR and the loop re-sent it
		// three more times on a transport the catalog says does not dedup.
		const fetchSpy = vi.fn().mockRejectedValue(new Error('Emailit API call timed out'));
		global.fetch = fetchSpy as unknown as typeof fetch;

		const dispatched = await sendProviderDispatch(fakeDispatchCtx(), 'emailit', params, {
			idempotencyKey: 'send_1',
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(dispatched.attempts).toBe(1);
		expect(dispatched.result).toMatchObject({
			success: false,
			errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			acceptanceUnknown: true,
		});
	});
});
