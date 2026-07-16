import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import {
	PLUGIN_CRON_MAX_INTERVAL_MINUTES,
	PLUGIN_CRON_MIN_INTERVAL_MINUTES,
} from '@owlat/plugin-kit';

vi.mock('../cronCatalog.generated', () => ({
	BUNDLED_PLUGIN_CRON_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.seed-lab.refresh-scores',
			pluginId: 'seed-lab',
			label: 'Refresh seed scores',
			intervalMinutes: 360,
			timeoutMs: 30_000,
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'scheduler:cron',
		}),
		Object.freeze({
			kind: 'plugin.knowledge-sync.pull',
			pluginId: 'knowledge-sync',
			label: 'Pull knowledge',
			intervalMinutes: 60,
			timeoutMs: 30_000,
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'scheduler:cron',
		}),
	]),
}));

import { CRON_CATALOG, type HostedCronDefinition } from '../cronCatalog';
import { planPluginCronRegistrations, registerBundledPluginCrons } from '../cronRegistration';

function definition(overrides: Partial<HostedCronDefinition>): HostedCronDefinition {
	return {
		kind: 'plugin.seed-lab.refresh-scores',
		pluginId: 'seed-lab',
		label: 'Refresh',
		intervalMinutes: 360,
		timeoutMs: 30_000,
		requiredEnvVars: [],
		requiredCapability: 'scheduler:cron',
		...overrides,
	};
}

describe('plugin cron registration planning', () => {
	it('names each cron by its collision-safe kind and preserves catalog order', () => {
		const plan = planPluginCronRegistrations(CRON_CATALOG);
		expect(plan.map((registration) => registration.name)).toEqual([
			'plugin.seed-lab.refresh-scores',
			'plugin.knowledge-sync.pull',
		]);
		expect(plan[0]).toMatchObject({
			name: 'plugin.seed-lab.refresh-scores',
			cronKind: 'plugin.seed-lab.refresh-scores',
			pluginId: 'seed-lab',
			intervalMinutes: 360,
		});
	});

	it('is idempotent: a duplicate kind is registered at most once', () => {
		const plan = planPluginCronRegistrations([
			definition({}),
			definition({}),
			definition({ pluginId: 'other', kind: 'plugin.other.job' }),
		]);
		expect(plan.map((registration) => registration.name)).toEqual([
			'plugin.seed-lab.refresh-scores',
			'plugin.other.job',
		]);
	});

	it('clamps intervals into the host scheduling limits', () => {
		const plan = planPluginCronRegistrations([
			definition({ kind: 'plugin.seed-lab.fast', intervalMinutes: 1 }),
			definition({ kind: 'plugin.seed-lab.slow', intervalMinutes: 10_000_000 }),
			definition({ kind: 'plugin.seed-lab.fractional', intervalMinutes: 30.7 }),
		]);
		expect(plan.map((registration) => registration.intervalMinutes)).toEqual([
			PLUGIN_CRON_MIN_INTERVAL_MINUTES,
			PLUGIN_CRON_MAX_INTERVAL_MINUTES,
			31,
		]);
	});

	it.each([
		['non-namespaced kind', definition({ kind: 'refresh-scores' })],
		['kind not owned by its plugin', definition({ kind: 'plugin.other.refresh' })],
		['empty local id', definition({ kind: 'plugin.seed-lab.' })],
		['non-finite interval', definition({ kind: 'plugin.seed-lab.nan', intervalMinutes: NaN })],
		['empty plugin id', definition({ pluginId: '', kind: 'plugin..refresh' })],
	])('skips a malformed catalog entry: %s', (_label, malformed) => {
		expect(planPluginCronRegistrations([malformed])).toEqual([]);
	});

	it('registers each planned cron on the shared table with wrapped attribution', () => {
		const calls: Array<{
			name: string;
			schedule: unknown;
			reference: string;
			args: unknown;
		}> = [];
		const crons = {
			interval: vi.fn((name: string, schedule: unknown, reference: unknown, args: unknown) => {
				calls.push({
					name,
					schedule,
					reference: getFunctionName(reference as never),
					args,
				});
			}),
		} as unknown as Parameters<typeof registerBundledPluginCrons>[0];

		registerBundledPluginCrons(crons);

		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			name: 'plugin.seed-lab.refresh-scores',
			schedule: { minutes: 360 },
			args: { pluginId: 'seed-lab', cronKind: 'plugin.seed-lab.refresh-scores' },
		});
		expect(calls[0]!.reference).toContain('cronRuntime');
		expect(calls[0]!.reference).toContain('runPluginCron');
		// unique names across the whole registration set
		expect(new Set(calls.map((call) => call.name)).size).toBe(calls.length);
	});
});
