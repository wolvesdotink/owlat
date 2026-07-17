import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../cronCatalog.generated', () => ({
	BUNDLED_PLUGIN_CRON_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.seed-lab.refresh-scores',
			pluginId: 'seed-lab',
			label: 'Refresh seed scores',
			intervalMinutes: 360,
			timeoutMs: 30_000,
			requiredEnvVars: Object.freeze(['SEED_TOKEN']),
			requiredCapability: 'scheduler:cron',
		}),
		Object.freeze({
			kind: 'plugin.unregistered-lab.refresh-scores',
			pluginId: 'unregistered-lab',
			label: 'Unregistered refresh',
			intervalMinutes: 360,
			timeoutMs: 30_000,
			requiredEnvVars: Object.freeze([]),
			requiredCapability: 'scheduler:cron',
		}),
	]),
}));

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/seed-lab',
			manifest: Object.freeze({
				id: 'seed-lab',
				version: '1.0.0',
				capabilities: Object.freeze(['scheduler:cron']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['SEED_TOKEN']),
				}),
			}),
		}),
	]),
}));

vi.mock('../audit', () => ({ recordHostedPluginAudit: audit }));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { authorizeExecution, recordOutcome } from '../cronAuthorization';

const authorizeHandler = (
	authorizeExecution as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; cronKind: string }) => Promise<boolean>;
	}
)._handler;
const outcomeHandler = (
	recordOutcome as unknown as {
		_handler: (
			ctx: unknown,
			args: {
				pluginId: string;
				cronKind: string;
				outcome: 'completed' | 'failed';
				reasonCode?: string;
			}
		) => Promise<void>;
	}
)._handler;
const flagKey = 'plugin.seed-lab';

function fakeContext(
	isEnabled: boolean,
	isGranted: boolean,
	organizations: readonly { id: string }[] = [{ id: 'organization-id' }]
) {
	return {
		runQuery: vi.fn(async () => ({ page: organizations })),
		db: {
			query: vi.fn(() => ({
				first: vi.fn(async () => ({
					featureFlags: { [flagKey]: isEnabled },
					pluginCapabilityGrants: { [flagKey]: { 'scheduler:cron': isGranted } },
				})),
			})),
		},
	};
}

describe('hosted plugin cron authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv('SEED_TOKEN', 'present');
	});

	it('authorizes only the catalogued kind owned by the requested plugin', async () => {
		const ctx = fakeContext(true, true);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'seed-lab',
				cronKind: 'plugin.seed-lab.refresh-scores',
			})
		).resolves.toBe(true);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'other-lab',
				cronKind: 'plugin.seed-lab.refresh-scores',
			})
		).resolves.toBe(false);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'seed-lab',
				cronKind: 'plugin.seed-lab.missing',
			})
		).resolves.toBe(false);
	});

	it.each([
		['disabled flag', false, true, 'present'],
		['missing grant', true, false, 'present'],
		['missing environment', true, true, ''],
	] as const)('denies and audits %s', async (_label, isEnabled, isGranted, key) => {
		vi.stubEnv('SEED_TOKEN', key);
		await expect(
			authorizeHandler(fakeContext(isEnabled, isGranted), {
				pluginId: 'seed-lab',
				cronKind: 'plugin.seed-lab.refresh-scores',
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'seed-lab' }),
			'cron.run',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});

	it.each([
		['zero organizations', []],
		['multiple organizations', [{ id: 'org-one' }, { id: 'org-two' }]],
	] as const)('denies safely with %s', async (_label, organizations) => {
		await expect(
			authorizeHandler(fakeContext(true, true, organizations), {
				pluginId: 'seed-lab',
				cronKind: 'plugin.seed-lab.refresh-scores',
			})
		).resolves.toBe(false);
		expect(audit).not.toHaveBeenCalled();
	});

	it('denies a catalogued cron whose plugin is no longer registered', async () => {
		await expect(
			authorizeHandler(fakeContext(true, true), {
				pluginId: 'unregistered-lab',
				cronKind: 'plugin.unregistered-lab.refresh-scores',
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'unregistered-lab' }),
			'cron.run',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});

	it('records only trusted attribution and bounded reason codes', async () => {
		await outcomeHandler(fakeContext(true, true), {
			pluginId: 'seed-lab',
			cronKind: 'plugin.seed-lab.refresh-scores',
			outcome: 'failed',
			reasonCode: 'cron_timeout',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'seed-lab' }),
			'cron.run',
			'failed',
			{ reasonCode: 'cron_timeout' }
		);
	});

	it('rejects an outcome whose attribution is not catalogued', async () => {
		await expect(
			outcomeHandler(fakeContext(true, true), {
				pluginId: 'seed-lab',
				cronKind: 'plugin.seed-lab.missing',
				outcome: 'completed',
			})
		).rejects.toThrow();
		expect(audit).not.toHaveBeenCalled();
	});
});
