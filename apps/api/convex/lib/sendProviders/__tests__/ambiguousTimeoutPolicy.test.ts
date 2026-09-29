/**
 * ONE AMBIGUOUS-TIMEOUT POLICY, READ FROM THE CATALOG (issue #860, finding 1).
 *
 * Adapters only report "timed out after dispatch" (`AMBIGUOUS_TIMEOUT`).
 * `sendProviderDispatch` decides the rest from two catalog fields, for every
 * kind alike:
 *
 *  - retry only when the kind declares `deduplicatesOnIdempotencyKey: true` AND
 *    the extras actually carry an idempotency key, because only then is a second
 *    request not a second mail;
 *  - otherwise stop after one attempt, and mark the result `acceptanceUnknown`
 *    exactly when the kind declares `acceptanceSemantics: 'unknown-on-timeout'`.
 *
 * The table is the core catalog itself, so a new kind is covered the day it is
 * declared, and a declaration change moves the expected outcome with it.
 *
 * Also here: the dispatch loop honours a provider's Retry-After (finding 8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_SEND_PROVIDER_CATALOG_ENTRIES } from '@owlat/shared';
import { providerFor } from '../index';
import { sendProviderDispatch } from '../dispatch';
import { fakeDispatchCtx } from './dispatchFixtures';
import { mandrillSendProvider, _resetMandrillConfigCacheForTests } from '../mandrill';
import { emailitSendProvider } from '../emailit';
import { EmailErrorCode, type EmailSendAttempt, type SendProviderKind } from '../types';
import { _resetSendTransportCacheForTests } from '../transports';

/**
 * Strip `readonly` to override a provider's retry schedule for a test, then
 * restore it. Zero delays keep the attempt count and remove the wall-clock wait.
 */
type WritableRetryDelays = { retryDelays: readonly number[] };
function setRetryDelays(kind: SendProviderKind, delays: readonly number[]): void {
	(providerFor(kind) as unknown as WritableRetryDelays).retryDelays = delays;
}

const params = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'subject',
	html: '<p>hi</p>',
};

const AMBIGUOUS: EmailSendAttempt = {
	success: false,
	errorMessage: 'request timed out after dispatch',
	errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe.each(CORE_SEND_PROVIDER_CATALOG_ENTRIES.map((entry) => [entry.kind, entry] as const))(
	'an ambiguous timeout on %s',
	(kind, entry) => {
		let originalDelays: readonly number[];

		beforeEach(() => {
			originalDelays = providerFor(kind).retryDelays;
			setRetryDelays(
				kind,
				originalDelays.map(() => 0)
			);
		});

		afterEach(() => {
			setRetryDelays(kind, originalDelays);
		});

		const maxAttempts = () => providerFor(kind).retryDelays.length + 1;

		it.each([
			{ label: 'with an idempotency key', extras: { idempotencyKey: 'send_1' } },
			{ label: 'with an empty idempotency key', extras: { idempotencyKey: '' } },
			{ label: 'without extras', extras: undefined },
		])('$label', async ({ extras }) => {
			const sendSpy = vi.spyOn(providerFor(kind), 'sendEmail').mockResolvedValue(AMBIGUOUS);

			const out = await sendProviderDispatch(fakeDispatchCtx(), kind, params, extras as never);

			const retried = entry.deduplicatesOnIdempotencyKey && !!extras?.idempotencyKey;
			expect(out.attempts).toBe(retried ? maxAttempts() : 1);
			expect(sendSpy).toHaveBeenCalledTimes(out.attempts);
			expect(out.result).toMatchObject({
				success: false,
				errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
			});
			if (out.result.success) throw new Error('expected a failure');
			// Stamped on the terminal result whether it came after one attempt or
			// after the last retry of a dedup kind also timed out.
			expect(out.result.acceptanceUnknown === true).toBe(
				entry.acceptanceSemantics === 'unknown-on-timeout'
			);
		});

		it('a retry that then succeeds returns the success untouched', async () => {
			if (!entry.deduplicatesOnIdempotencyKey) return;
			vi.spyOn(providerFor(kind), 'sendEmail')
				.mockResolvedValueOnce(AMBIGUOUS)
				.mockResolvedValueOnce({ success: true, id: 'msg-2' });

			const out = await sendProviderDispatch(fakeDispatchCtx(), kind, params, {
				idempotencyKey: 'send_1',
			} as never);

			expect(out.attempts).toBe(2);
			expect(out.result).toEqual({ success: true, id: 'msg-2' });
		});
	}
);

describe('Retry-After in the dispatch loop', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		_resetSendTransportCacheForTests();
		_resetMandrillConfigCacheForTests();
		vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
		vi.stubEnv('EMAILIT_API_KEY', 'emailit-test-key');
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
		_resetSendTransportCacheForTests();
		_resetMandrillConfigCacheForTests();
	});

	function throttled(retryAfterSeconds: number): Response {
		return new Response(JSON.stringify({ status: 'error', message: 'Too many requests' }), {
			status: 429,
			headers: { 'Retry-After': String(retryAfterSeconds) },
		});
	}

	const SUCCESS_BODIES = {
		mandrill: () =>
			new Response(JSON.stringify([{ email: 'to@example.com', status: 'queued', _id: 'md-1' }]), {
				status: 200,
			}),
		emailit: () => new Response(JSON.stringify({ id: 'em-1' }), { status: 200 }),
	} as const;

	it.each([
		{ kind: 'mandrill' as const, module: mandrillSendProvider },
		{ kind: 'emailit' as const, module: emailitSendProvider },
	])(
		'$kind: a 429 with Retry-After: 2 waits at least 2 s before the retry',
		async ({ kind, module }) => {
			// The schedule's first step is 1 s, so waiting it alone would re-hit a
			// provider that asked for 2 s.
			expect(module.retryDelays[0]).toBeLessThan(2_000);
			const fetchSpy = vi
				.fn()
				.mockResolvedValueOnce(throttled(2))
				.mockResolvedValueOnce(SUCCESS_BODIES[kind]());
			global.fetch = fetchSpy as unknown as typeof fetch;

			const pending = sendProviderDispatch(fakeDispatchCtx(), kind, params);

			await vi.advanceTimersByTimeAsync(1_999);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			const out = await pending;

			expect(fetchSpy).toHaveBeenCalledTimes(2);
			expect(out.attempts).toBe(2);
			expect(out.result.success).toBe(true);
		}
	);

	it.each([
		{ kind: 'mandrill' as const, module: mandrillSendProvider },
		{ kind: 'emailit' as const, module: emailitSendProvider },
	])(
		'$kind: a Retry-After beyond the loop budget returns terminal after one attempt',
		async ({ kind, module }) => {
			const budgetMs = module.retryDelays.reduce((sum, ms) => sum + ms, 0);
			const retryAfterSeconds = Math.ceil(budgetMs / 1_000) + 60;
			const fetchSpy = vi.fn().mockResolvedValue(throttled(retryAfterSeconds));
			global.fetch = fetchSpy as unknown as typeof fetch;

			const out = await sendProviderDispatch(fakeDispatchCtx(), kind, params);

			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(out.attempts).toBe(1);
			expect(out.result).toMatchObject({
				success: false,
				errorCode: EmailErrorCode.RATE_LIMIT,
				retryAfterMs: retryAfterSeconds * 1_000,
			});
		}
	);
});
