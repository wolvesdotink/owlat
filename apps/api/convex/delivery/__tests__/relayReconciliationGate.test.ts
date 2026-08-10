/**
 * "HAS THE PLAN ALREADY PUT US ON A RELAY?" IS A CAPABILITY, NOT A NAME (the
 * seams plan's P0.4).
 *
 * When the MTA answers `relay` and the base arm is our own, `lastMileRouting`
 * either re-resolves a governed relay route with `forceRelayReason` or accepts
 * the route the send plan already carries. The gate used to spell that second
 * half `route?.providerType !== 'ses'`, which picked out the right routes only
 * while SES was the one relay `setRoute` would save. Since P0.2 it is not — so
 * two deployments with byte-identical configuration, differing only in the NAME
 * of their relay, took different code paths through the hottest decision on the
 * send path.
 *
 * DIFFERENTIAL, in both directions. The SES cases pin that the shipped route is
 * unchanged; the Mandrill/SMTP cases are unsatisfiable by an `=== 'ses'` gate
 * and would have failed before this sweep; the own-arm and absent-route cases
 * pin that "no relay yet" still goes and finds one, which is the whole reason
 * the branch exists.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';

const resolveMtaRoutingDecision = vi.fn();
vi.mock('../../lib/sendProviders/mta', () => ({ resolveMtaRoutingDecision }));

const { resolveLastMileRouting } = await import('../lastMileRouting');

const input = {
	messageType: 'campaign' as const,
	to: 'person@gmail.com',
	from: 'sender@example.org',
	organizationId: 'org-1',
	idempotencyKey: 'send-1',
	workAttemptId: 'work-1',
	routingReentryToken: 'reentry-1',
	startedAt: Date.now(),
	deliveryDomain: 'production' as const,
};

const baseRoute = { providerType: 'mta' as const, source: 'org_config' as const };

/** Every `runQuery` the boundary makes, in order, with the args it was given. */
function context(...results: unknown[]) {
	const calls: unknown[] = [];
	const queue = [...results];
	const ctx = {
		runQuery: vi.fn(async (_ref: unknown, args: unknown) => {
			calls.push(args);
			return queue.shift();
		}),
	} as unknown as ActionCtx;
	return { ctx, calls };
}

beforeEach(() => {
	// The governed path is only reached with the MTA decision endpoint configured.
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'key');
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe('the relay-reconciliation gate reads the relay DEFINITION, not a provider name', () => {
	it.each(['ses', 'mandrill', 'smtp', 'resend'] as const)(
		'accepts the %s relay route the plan already resolved, without re-resolving it',
		async (providerType) => {
			resolveMtaRoutingDecision.mockResolvedValue({ kind: 'relay', reason: 'breaker_open' });
			const route = { providerType, source: 'deliverability_fallback' as const };
			const { ctx, calls } = context({ route, baseRoute, isMtaGoverned: true });

			const result = await resolveLastMileRouting(ctx, input);

			expect(result).toMatchObject({ kind: 'ready', providerKind: providerType, route });
			// One query — the send plan. A second would be `resolveGovernedRelayRoute`
			// re-deciding a relay we are already on.
			expect(
				calls.filter(
					(args) => typeof args === 'object' && args !== null && 'forceRelayReason' in args
				)
			).toEqual([]);
		}
	);

	it.each([
		{ label: 'the own arm', providerType: 'mta' as const },
		{ label: 'nothing at all', providerType: undefined },
	])('goes and finds a relay when the plan carries %s', async ({ providerType }) => {
		resolveMtaRoutingDecision.mockResolvedValue({ kind: 'relay', reason: 'breaker_open' });
		const route =
			providerType === undefined ? null : { providerType, source: 'org_config' as const };
		const relayRoute = { providerType: 'ses' as const, source: 'deliverability_fallback' as const };
		// `input` carries an organizationId, so the boundary makes exactly two
		// queries here: the send plan, then the forced relay resolution.
		const { ctx, calls } = context(
			{ route, baseRoute, isMtaGoverned: true },
			{ route: relayRoute }
		);

		const result = await resolveLastMileRouting(ctx, input);

		expect(result).toMatchObject({ kind: 'ready', providerKind: 'ses', route: relayRoute });
		expect(
			calls.filter(
				(args) => typeof args === 'object' && args !== null && 'forceRelayReason' in args
			)
		).toHaveLength(1);
	});
});
