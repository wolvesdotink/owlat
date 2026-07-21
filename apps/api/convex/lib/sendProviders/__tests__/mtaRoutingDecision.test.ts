import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailErrorCode } from '../types';
import { mtaSendProvider, resolveMtaRoutingDecision } from '../mta';

const decisionInput = {
	messageId: 'send-1',
	organizationId: 'org-1',
	recipient: 'to@example.com',
	from: 'from@example.com',
	candidateProvider: 'mta' as const,
	ipPool: 'campaign' as const,
	allowWarmupOverflow: true,
};

describe('MTA routing decision client', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.stubEnv('MTA_API_URL', 'https://mta.test');
		vi.stubEnv('MTA_API_KEY', 'test-key');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		global.fetch = originalFetch;
		vi.useRealTimers();
	});

	it.each([
		new Response('upstream failed', { status: 503 }),
		new Response(JSON.stringify({ decision: 'mta', lease: {} }), { status: 200 }),
		new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
	])('fails closed on a non-2xx or malformed routing decision', async (response) => {
		global.fetch = vi.fn().mockResolvedValue(response);
		expect(await resolveMtaRoutingDecision(decisionInput)).toEqual({
			kind: 'defer',
			retryAfterMs: 60_000,
		});
	});

	it('fails closed when the routing decision exceeds its network timeout', async () => {
		vi.useFakeTimers();
		global.fetch = vi.fn(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					if (!init?.signal) throw new Error('expected an abort signal');
					init.signal.addEventListener('abort', () => reject(new Error('aborted')));
				})
		) as typeof fetch;
		const pending = resolveMtaRoutingDecision(decisionInput);
		await vi.advanceTimersByTimeAsync(5_001);
		expect(await pending).toEqual({ kind: 'defer', retryAfterMs: 60_000 });
	});

	it.each(['ROUTING_DECISION_EXPIRED', 'ROUTING_DECISION_CHANGED', 'GLOBAL_SAFETY_DEFER'])(
		'classifies a %s enqueue race as retryable',
		(code) => {
			expect(mtaSendProvider.categorizeError(JSON.stringify({ code }), 409)).toBe(
				EmailErrorCode.SERVER_ERROR
			);
		}
	);
});
