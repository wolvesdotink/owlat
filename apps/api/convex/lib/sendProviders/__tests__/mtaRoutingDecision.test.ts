import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailErrorCode } from '../types';
import { mtaSendProvider, resolveMtaRoutingDecision } from '../mta';
import { MTA_DEFER_REASON_ORIGIN } from '@owlat/mta-protocol/routingDecision';
import { ROUTING_LEASE_TOKEN_MAX_LENGTH, ROUTING_LEASE_UNREADABLE_CODE } from '@owlat/shared';
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
	// so it comes back `local` and gate 2 does not count it. That covers the
	// direction where the MTA gains a reason the table has not; the classification
	// cases further down cover the opposite direction, a reason in the table with
	// no case naming its origin.
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
	// `lease_persistence` rode along with the three governance reasons and made a
	// Redis failure on our own MTA count against gate 2's 25% halt line — and it
	// drifted because nobody had to write the pairs down. This list is the second
	// witness: hand-written here, compared against the shipped table below, so a
	// reason added to `MTA_DEFER_REASON_ORIGIN` with nobody vouching for its origin
	// fails the suite rather than riding along.
	const DEFER_REASON_CASES = [
		{ reason: 'global_safety', origin: 'governed' },
		{ reason: 'global_probe', origin: 'governed' },
		{ reason: 'no_owned_ip', origin: 'governed' },
		// OUR OWN STORAGE, not the receiver: any Redis failure while the MTA takes
		// the lease — reserving a half-open probe or writing the lease record — lands
		// on one catch (`apps/mta/src/routes/routingDecision.ts`).
		{ reason: 'lease_persistence', origin: 'local' },
	] as const;

	it('leaves no shipped defer reason unclassified by this suite', () => {
		expect(Object.fromEntries(DEFER_REASON_CASES.map((c) => [c.reason, c.origin]))).toEqual(
			MTA_DEFER_REASON_ORIGIN
		);
	});

	it.each(DEFER_REASON_CASES)(
		'classifies the $reason deferral as $origin',
		async ({ reason, origin }) => {
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
		}
	);

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

	// ISSUE #505: the intake 409 that is NOT governance. A lease the MTA could not
	// read back is its own store failing, so it must arrive as its own code and
	// not be folded into the `ROUTING_DECISION_` prefix match above — that bucket
	// is the one gate 2 halts a cell over.
	it('carries an unreadable-lease 409 through as its own code', () => {
		expect(
			mtaSendProvider.categorizeError(
				JSON.stringify({
					error: 'Routing lease could not be read; resolve again',
					code: ROUTING_LEASE_UNREADABLE_CODE,
				}),
				409
			)
		).toBe(EmailErrorCode.ROUTING_LEASE_UNREADABLE);
	});
});
