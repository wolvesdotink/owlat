import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectSendProviderKind } from '../types';
import { resolveRoute, type ProviderRouteConfig } from '../routing';
import type { ProviderHealthStatus } from '../strategies/types';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('selectSendProviderKind', () => {
	it('uses a recognized explicit provider instead of EMAIL_PROVIDER', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		expect(selectSendProviderKind('resend')).toBe('resend');
	});

	it.each(['plugin.retired-mail.postmark', ''])(
		'fails closed for the explicit value %j even when EMAIL_PROVIDER is valid',
		(providerType) => {
			vi.stubEnv('EMAIL_PROVIDER', 'mta');
			expect(selectSendProviderKind(providerType)).toBeNull();
		}
	);

	it('uses EMAIL_PROVIDER only when the explicit provider is absent', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		expect(selectSendProviderKind(undefined)).toBe('mta');
	});

	it('recognises mandrill from both selection paths (P1.1)', () => {
		// The day-0 arrival shape from the activation matrix: `EMAIL_PROVIDER=mandrill`
		// with no route rows, everything relaying through the account they came with.
		vi.stubEnv('EMAIL_PROVIDER', 'mandrill');
		expect(selectSendProviderKind(undefined)).toBe('mandrill');
		// …and once routes exist, the producer's explicit choice is authoritative.
		expect(selectSendProviderKind('mandrill')).toBe('mandrill');
	});

	it('fails closed when both provider selections are absent or invalid', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'retired');
		expect(selectSendProviderKind(undefined)).toBeNull();
		vi.stubEnv('EMAIL_PROVIDER', '');
		expect(selectSendProviderKind(undefined)).toBeNull();
	});
});

/**
 * MANDRILL ROUTES UNDER EVERY STRATEGY (P1.3).
 *
 * Nothing in `resolveRoute` or in the four strategy modules names a provider —
 * that is the design — so the only way to know a new kind actually FLOWS is to
 * resolve a route through each of them and look at the answer. The suites next
 * door assert each strategy's own rule (`strategies.test.ts`) and each kind's
 * adapter (`mandrill/__tests__/`); this is the seam BETWEEN them, and it is the
 * seam a hard-coded kind list would break silently: a route that quietly never
 * selects the relay produces sends, health rows and assignment rows that all
 * look fine and all describe the wrong arm.
 *
 * Every case configures the mix the plan's activation matrix describes — the
 * owned MTA plus Mandrill — rather than Mandrill alone, because a single-entry
 * route resolves the same way for every strategy and would pass whatever the
 * strategy did with it.
 */
describe('resolveRoute — Mandrill under every strategy', () => {
	// No ambient provider env: each case decides for itself whether the env
	// fallback is part of what it is asserting.
	beforeEach(() => {
		vi.stubEnv('EMAIL_PROVIDER', '');
	});

	function routeWith(strategy: ProviderRouteConfig['strategy']): ProviderRouteConfig {
		return {
			strategy,
			providers: [
				{ providerType: 'mandrill', isEnabled: true, weight: 50 },
				{ providerType: 'mta', isEnabled: true, weight: 50 },
			],
		};
	}

	it('single: the first enabled entry may be Mandrill', () => {
		expect(resolveRoute(routeWith('single'))).toMatchObject({
			providerType: 'mandrill',
			source: 'org_config',
		});
	});

	it('priority_failover: Mandrill leads, and health can fail over TO and FROM it', () => {
		const config = routeWith('priority_failover');
		expect(resolveRoute(config)).toMatchObject({ providerType: 'mandrill' });

		const mandrillDown: ProviderHealthStatus[] = [
			{ providerType: 'mandrill', status: 'down', successRate: 0.1 },
			{ providerType: 'mta', status: 'healthy', successRate: 0.99 },
		];
		expect(resolveRoute(config, mandrillDown)).toMatchObject({ providerType: 'mta' });

		const mtaDown: ProviderHealthStatus[] = [
			{ providerType: 'mandrill', status: 'healthy', successRate: 0.99 },
			{ providerType: 'mta', status: 'down', successRate: 0.1 },
		];
		expect(
			resolveRoute({ ...config, providers: [...config.providers].reverse() }, mtaDown)
		).toMatchObject({ providerType: 'mandrill' });
	});

	it('workload_split: Mandrill takes its weighted share of the draws', () => {
		const config = routeWith('workload_split');
		const seen = new Set<string>();
		for (let draw = 0; draw < 100; draw += 1) {
			const resolved = resolveRoute(config);
			expect(resolved).not.toBeNull();
			seen.add(resolved!.providerType);
		}
		// Both arms appear over 100 even draws; a kind the split could not select
		// would leave the set at exactly one member.
		expect([...seen].sort()).toEqual(['mandrill', 'mta']);
	});

	it('adaptive_mix: Mandrill is the REFERENCE arm the share splits against', () => {
		const config = routeWith('adaptive_mix');
		// s = 0 is the migration's starting position (D8): the whole cell goes to
		// the account the deployment arrived with.
		expect(
			resolveRoute(config, undefined, () => true, undefined, {
				kind: 'decide',
				input: { cell: { ownShare: 0, mixVersion: 1 }, recipient: { contactId: 'c1' } },
			})
		).toMatchObject({ providerType: 'mandrill', source: 'org_config' });
		// …and s = 1 is the end of it, with the own MTA carrying everything.
		expect(
			resolveRoute(config, undefined, () => true, undefined, {
				kind: 'decide',
				input: { cell: { ownShare: 1, mixVersion: 1 }, recipient: { contactId: 'c1' } },
			})
		).toMatchObject({ providerType: 'mta' });
		// A RECORDED arm replays onto the same transport, which is what makes the
		// enqueue-time assignment row and the dispatch-time route agree.
		expect(
			resolveRoute(config, undefined, () => true, undefined, {
				kind: 'assigned',
				arm: 'reference',
			})
		).toMatchObject({ providerType: 'mandrill' });
	});

	it('day-0 arrival: EMAIL_PROVIDER=mandrill with no route rows resolves to Mandrill', () => {
		// The activation matrix's first row — everything relays through the
		// Mandrill account, with nothing configured in `providerRoutes` at all.
		vi.stubEnv('EMAIL_PROVIDER', 'mandrill');
		expect(resolveRoute(null)).toEqual({ providerType: 'mandrill', source: 'env_fallback' });
		// The same fallback catches a route whose providers are all disabled.
		expect(
			resolveRoute({
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: false }],
			})
		).toEqual({ providerType: 'mandrill', source: 'env_fallback' });
	});

	it('deliverability fallback: an actionable signal drains the MTA slice to Mandrill', () => {
		// The measured-migration shape from the activation matrix, now that the
		// persistence gate accepts it (D6).
		const config: ProviderRouteConfig = {
			strategy: 'priority_failover',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'mandrill',
				isWarmupOverflowEnabled: false,
			},
		};
		expect(
			resolveRoute(config, undefined, () => true, {
				activeReasons: ['breaker_open'],
				isWarmupOverflow: false,
				isRelayDomainVerified: true,
			})
		).toEqual({
			providerType: 'mandrill',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
		// Unconfigured, the same route fails closed rather than routing to a relay
		// whose credentials are absent — one predicate with `providerRoutes.setRoute`.
		expect(() =>
			resolveRoute(config, undefined, (kind) => kind === 'mta', {
				activeReasons: ['breaker_open'],
				isWarmupOverflow: false,
				isRelayDomainVerified: true,
			})
		).toThrow(/relay unavailable/i);
	});
});
