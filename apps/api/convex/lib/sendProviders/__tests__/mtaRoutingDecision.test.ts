import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailErrorCode } from '../types';
import { mtaSendProvider, resolveMtaRoutingDecision } from '../mta';
import { ROUTING_LEASE_TOKEN_MAX_LENGTH } from '@owlat/shared';

const decisionInput = {
	messageId: 'send-1',
	workAttemptId: 'work-1',
	routingReentryToken: 'reentry-1',
	startedAt: Date.now(),
	deliveryDomain: 'production' as const,
	messageType: 'campaign' as const,
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

	it.each([
		{ decision: 'mta', lease: { token: 'lease-1', expiresAt: Date.now() } },
		{ decision: 'mta', lease: { token: 'lease-1' }, unexpected: true },
		{ decision: 'mta', lease: { token: 'x'.repeat(ROUTING_LEASE_TOKEN_MAX_LENGTH + 1) } },
		{ decision: 'relay', reason: 'provider_breaker', unexpected: true },
		{ decision: 'defer', reason: 'global_safety', retryAfterMs: 1_000, unexpected: true },
		{ decision: 'defer', retryAfterMs: 1_000 },
		{ decision: 'defer', reason: 'invented_reason', retryAfterMs: 1_000 },
		{ decision: 'defer', reason: 'global_safety' },
	])('rejects an inexact decision response: %j', async (body) => {
		global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
		expect(await resolveMtaRoutingDecision(decisionInput)).toEqual({
			kind: 'defer',
			retryAfterMs: 60_000,
		});
	});

	it('accepts exact decisions and bounds finite defer delays', async () => {
		for (const [body, expected] of [
			[
				{ decision: 'mta', lease: { token: 'lease-1' } },
				{ kind: 'mta', leaseToken: 'lease-1' },
			],
			[
				{ decision: 'relay', reason: 'provider_probe_limit' },
				{ kind: 'relay', reason: 'provider_probe_limit' },
			],
			[
				{ decision: 'defer', reason: 'global_safety', retryAfterMs: -1 },
				{ kind: 'defer', retryAfterMs: 1_000 },
			],
			[
				{ decision: 'defer', reason: 'global_safety', retryAfterMs: 9_000_000 },
				{ kind: 'defer', retryAfterMs: 3_600_000 },
			],
		] as const) {
			global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
			expect(await resolveMtaRoutingDecision(decisionInput)).toEqual(expected);
		}
	});

	it.each(['ROUTING_DECISION_EXPIRED', 'ROUTING_DECISION_CHANGED', 'GLOBAL_SAFETY_DEFER'])(
		'classifies a %s enqueue race as a fresh-routing deferral',
		(code) => {
			expect(mtaSendProvider.categorizeError(JSON.stringify({ code }), 409)).toBe(
				EmailErrorCode.ROUTING_DEFERRED
			);
		}
	);
});
