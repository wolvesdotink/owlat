import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailErrorCode } from '../types';
import { mtaSendProvider, resolveMtaRoutingDecision } from '../mta';
import { ROUTING_LEASE_TOKEN_MAX_LENGTH } from '@owlat/shared';
import { resolveSendTransport } from '../transports';

const MTA_TRANSPORT = resolveSendTransport('mta');

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
		// LOCAL, not governed: we never got an answer, so nothing was observed about
		// this sending identity and gate 2 must not count it (`deferralOutcome.ts`).
		expect(await resolveMtaRoutingDecision(MTA_TRANSPORT, decisionInput)).toEqual({
			kind: 'defer',
			retryAfterMs: 60_000,
			origin: 'local',
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
		const pending = resolveMtaRoutingDecision(MTA_TRANSPORT, decisionInput);
		await vi.advanceTimersByTimeAsync(5_001);
		expect(await pending).toEqual({ kind: 'defer', retryAfterMs: 60_000, origin: 'local' });
	});

	// `invented_reason` is the fall-through this list exists to pin: a defer
	// reason the adapter does not recognise is an answer we did not understand,
	// so it comes back `local` and gate 2 does not count it. Adding a defer reason
	// on the MTA side means adding it here and in `resolveMtaRoutingDecision`.
	it.each([
		{ decision: 'mta', lease: { token: 'lease-1', providerProbe: false } },
		{ decision: 'mta', lease: { token: 'lease-1' }, unexpected: true },
		{ decision: 'mta', lease: { token: 'x'.repeat(ROUTING_LEASE_TOKEN_MAX_LENGTH + 1) } },
		{ decision: 'relay', reason: 'provider_breaker', unexpected: true },
		{ decision: 'defer', reason: 'global_safety', retryAfterMs: 1_000, unexpected: true },
		{ decision: 'defer', retryAfterMs: 1_000 },
		{ decision: 'defer', reason: 'invented_reason', retryAfterMs: 1_000 },
		{ decision: 'defer', reason: 'global_safety' },
	])('rejects an inexact decision response: %j', async (body) => {
		global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
		expect(await resolveMtaRoutingDecision(MTA_TRANSPORT, decisionInput)).toEqual({
			kind: 'defer',
			retryAfterMs: 60_000,
			origin: 'local',
		});
	});

	// EVERY DEFER REASON, NAMED, WITH ITS ORIGIN. The list drifted once already —
	// `lease_persistence` rode along with the three governance reasons and made an
	// MTA Redis write failure count against gate 2's 25% halt line — and it
	// drifted because nobody had to write the pairs down. A new reason added to
	// `MTA_DEFER_REASON_ORIGIN` without a case here leaves this suite passing on a
	// reason it has never seen; that is what the fall-through case below covers.
	it.each([
		{ reason: 'global_safety', origin: 'governed' },
		{ reason: 'global_probe', origin: 'governed' },
		{ reason: 'no_owned_ip', origin: 'governed' },
		// OUR OWN STORAGE, not the receiver: the MTA granted the lease and then
		// failed to write it (`apps/mta/src/routes/routingDecision.ts`).
		{ reason: 'lease_persistence', origin: 'local' },
	])('classifies the $reason deferral as $origin', async ({ reason, origin }) => {
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ decision: 'defer', reason, retryAfterMs: 30_000 }), {
				status: 200,
			})
		);
		expect(await resolveMtaRoutingDecision(MTA_TRANSPORT, decisionInput)).toEqual({
			kind: 'defer',
			// The MTA's delay is honoured whoever is at fault — only the counting
			// differs.
			retryAfterMs: 30_000,
			origin,
		});
	});

	it('accepts exact decisions and bounds finite defer delays', async () => {
		for (const [body, expected] of [
			[
				{
					decision: 'mta',
					lease: { token: 'lease-1', providerProbe: true, globalProbe: false },
				},
				{
					kind: 'mta',
					leaseToken: 'lease-1',
					isProviderProbe: true,
					isGlobalProbe: false,
				},
			],
			[
				{ decision: 'relay', reason: 'provider_probe_limit' },
				{ kind: 'relay', reason: 'provider_probe_limit' },
			],
			[
				{ decision: 'defer', reason: 'global_safety', retryAfterMs: -1 },
				{ kind: 'defer', retryAfterMs: 1_000, origin: 'governed' },
			],
			[
				{ decision: 'defer', reason: 'global_safety', retryAfterMs: 9_000_000 },
				{ kind: 'defer', retryAfterMs: 3_600_000, origin: 'governed' },
			],
		] as const) {
			global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
			expect(await resolveMtaRoutingDecision(MTA_TRANSPORT, decisionInput)).toEqual(expected);
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
