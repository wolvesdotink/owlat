import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	strategyFor,
	isSendRouteStrategyKind,
	SEND_ROUTE_STRATEGIES,
	type ProviderEntry,
	type ProviderHealthStatus,
	type SendRouteStrategyKind,
} from '../strategies';
import { resolveRoute, type ProviderRouteConfig } from '../routing';

describe('Send route strategy registry', () => {
	it('strategyFor returns the module for each kind', () => {
		expect(strategyFor('single').kind).toBe('single');
		expect(strategyFor('priority_failover').kind).toBe('priority_failover');
		expect(strategyFor('workload_split').kind).toBe('workload_split');
	});

	it('strategyFor throws on unknown kinds', () => {
		expect(() =>
			strategyFor('unknown' as SendRouteStrategyKind),
		).toThrow(/Unknown send route strategy/);
	});

	it('SEND_ROUTE_STRATEGIES has exactly the three documented kinds', () => {
		const keys = Object.keys(SEND_ROUTE_STRATEGIES).sort();
		expect(keys).toEqual(['priority_failover', 'single', 'workload_split']);
	});

	it('isSendRouteStrategyKind narrows correctly', () => {
		expect(isSendRouteStrategyKind('single')).toBe(true);
		expect(isSendRouteStrategyKind('priority_failover')).toBe(true);
		expect(isSendRouteStrategyKind('workload_split')).toBe(true);
		expect(isSendRouteStrategyKind('unknown')).toBe(false);
		expect(isSendRouteStrategyKind(undefined)).toBe(false);
	});
});

describe('singleStrategy', () => {
	it('returns the first enabled entry', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: true },
		];
		expect(strategyFor('single').select(entries, undefined)).toEqual({
			providerType: 'mta',
			ipPool: undefined,
			source: 'org_config',
		});
	});

	it('returns null with empty entries', () => {
		expect(strategyFor('single').select([], undefined)).toBeNull();
	});

	it('threads ipPool through', () => {
		const entries: ProviderEntry[] = [{ providerType: 'mta', isEnabled: true }];
		expect(strategyFor('single').select(entries, 'pool-x')).toMatchObject({
			ipPool: 'pool-x',
		});
	});
});

describe('priorityFailoverStrategy', () => {
	it('returns first entry when no health data', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: true },
		];
		expect(strategyFor('priority_failover').select(entries, undefined)).toMatchObject({
			providerType: 'mta',
		});
	});

	it('skips entries with status "down"', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: true },
		];
		const health: ProviderHealthStatus[] = [
			{ providerType: 'mta', status: 'down', successRate: 0.1 },
			{ providerType: 'ses', status: 'healthy', successRate: 0.99 },
		];
		expect(
			strategyFor('priority_failover').select(entries, undefined, health),
		).toMatchObject({ providerType: 'ses' });
	});

	it('accepts "degraded" providers (only "down" is excluded)', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: true },
		];
		const health: ProviderHealthStatus[] = [
			{ providerType: 'mta', status: 'degraded', successRate: 0.6 },
			{ providerType: 'ses', status: 'healthy', successRate: 0.99 },
		];
		expect(
			strategyFor('priority_failover').select(entries, undefined, health),
		).toMatchObject({ providerType: 'mta' });
	});

	it('falls through to first when all are down', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'ses', isEnabled: true },
		];
		const health: ProviderHealthStatus[] = [
			{ providerType: 'mta', status: 'down', successRate: 0.1 },
			{ providerType: 'ses', status: 'down', successRate: 0.1 },
		];
		expect(
			strategyFor('priority_failover').select(entries, undefined, health),
		).toMatchObject({ providerType: 'mta' });
	});

	it('returns null when entries empty', () => {
		expect(strategyFor('priority_failover').select([], undefined)).toBeNull();
	});
});

describe('workloadSplitStrategy', () => {
	it('returns null with empty entries', () => {
		expect(strategyFor('workload_split').select([], undefined)).toBeNull();
	});

	it('returns one of the candidates over many samples', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true, weight: 50 },
			{ providerType: 'ses', isEnabled: true, weight: 50 },
		];
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) {
			const out = strategyFor('workload_split').select(entries, undefined);
			expect(out).not.toBeNull();
			seen.add(out!.providerType);
		}
		// Statistically over 50 samples both should appear.
		expect(seen.has('mta') && seen.has('ses')).toBe(true);
	});

	it('honors weights (heavily-weighted entry wins most samples)', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true, weight: 1 },
			{ providerType: 'ses', isEnabled: true, weight: 999 },
		];
		let sesCount = 0;
		const total = 200;
		for (let i = 0; i < total; i++) {
			const out = strategyFor('workload_split').select(entries, undefined);
			if (out?.providerType === 'ses') sesCount++;
		}
		// With weight 999:1, SES should dominate. Allow some slack for randomness.
		expect(sesCount).toBeGreaterThan(total * 0.9);
	});

	it('excludes entries with status "down" from selection', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true, weight: 100 },
			{ providerType: 'ses', isEnabled: true, weight: 100 },
		];
		const health: ProviderHealthStatus[] = [
			{ providerType: 'mta', status: 'down', successRate: 0.1 },
			{ providerType: 'ses', status: 'healthy', successRate: 0.99 },
		];
		for (let i = 0; i < 20; i++) {
			const out = strategyFor('workload_split').select(entries, undefined, health);
			expect(out?.providerType).toBe('ses');
		}
	});

	it('falls back to full pool when all are down (preserves pre-deepening behavior)', () => {
		const entries: ProviderEntry[] = [
			{ providerType: 'mta', isEnabled: true, weight: 100 },
			{ providerType: 'ses', isEnabled: true, weight: 100 },
		];
		const health: ProviderHealthStatus[] = [
			{ providerType: 'mta', status: 'down', successRate: 0.1 },
			{ providerType: 'ses', status: 'down', successRate: 0.1 },
		];
		const out = strategyFor('workload_split').select(entries, undefined, health);
		expect(out).not.toBeNull();
	});
});

describe('resolveRoute (dispatcher + fallbacks)', () => {
	// Default to NO provider env so the fallback cases exercise the unconfigured
	// (null) path; the env_fallback case stubs EMAIL_PROVIDER explicitly.
	beforeEach(() => {
		vi.unstubAllEnvs();
		vi.stubEnv('EMAIL_PROVIDER', '');
	});
	afterEach(() => vi.unstubAllEnvs());

	it('null config with no provider env resolves to null (unconfigured, no phantom mta)', () => {
		expect(resolveRoute(null)).toBeNull();
	});

	it('null config + EMAIL_PROVIDER env returns env_fallback', () => {
		vi.stubEnv('EMAIL_PROVIDER', 'resend');
		expect(resolveRoute(null)).toEqual({ providerType: 'resend', source: 'env_fallback' });
	});

	it('config with no enabled providers + no env resolves to null', () => {
		const config: ProviderRouteConfig = {
			strategy: 'single',
			providers: [{ providerType: 'mta', isEnabled: false }],
		};
		expect(resolveRoute(config)).toBeNull();
	});

	it('config with unknown provider entry filters it out (null when nothing left + no env)', () => {
		const config: ProviderRouteConfig = {
			strategy: 'single',
			providers: [{ providerType: 'postmark', isEnabled: true }],
		};
		expect(resolveRoute(config)).toBeNull();
	});

	it('single strategy: returns org_config with first enabled', () => {
		const config: ProviderRouteConfig = {
			strategy: 'single',
			providers: [{ providerType: 'ses', isEnabled: true }],
			ipPool: 'pool-A',
		};
		expect(resolveRoute(config)).toMatchObject({
			providerType: 'ses',
			ipPool: 'pool-A',
			source: 'org_config',
		});
	});

	it('priority_failover with health: skips down providers', () => {
		const config: ProviderRouteConfig = {
			strategy: 'priority_failover',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
		};
		const health: ProviderHealthStatus[] = [
			{ providerType: 'mta', status: 'down', successRate: 0.1 },
			{ providerType: 'ses', status: 'healthy', successRate: 0.99 },
		];
		expect(resolveRoute(config, health)).toMatchObject({ providerType: 'ses' });
	});

	it('unknown strategy literal falls back to env (null when no env)', () => {
		const config = {
			strategy: 'mystery' as 'single',
			providers: [{ providerType: 'mta', isEnabled: true }],
		};
		expect(resolveRoute(config)).toBeNull();
	});
});
