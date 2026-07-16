import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../autonomyGateCatalog.generated', () => ({
	BUNDLED_PLUGIN_AUTONOMY_GATE_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.policy-pack.final-review',
			pluginId: 'policy-pack',
			label: 'Final policy review',
			timeoutMs: 500,
			requiredEnvVars: Object.freeze(['POLICY_KEY']),
			requiredCapability: 'send:gate',
		}),
	]),
}));

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:gate']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['POLICY_KEY']),
				}),
			}),
		}),
	]),
}));

vi.mock('../audit', () => ({ recordHostedPluginAudit: audit }));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { authorizeExecution, recordOutcome } from '../autonomyGateAuthorization';

const authorizeHandler = (
	authorizeExecution as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; gateKind: string }) => Promise<boolean>;
	}
)._handler;
const outcomeHandler = (
	recordOutcome as unknown as {
		_handler: (
			ctx: unknown,
			args: {
				pluginId: string;
				gateKind: string;
				outcome: 'completed' | 'failed';
				reasonCode?: string;
			}
		) => Promise<void>;
	}
)._handler;
const flagKey = 'plugin.policy-pack';

function fakeContext(isEnabled: boolean, isGranted: boolean) {
	return {
		runQuery: vi.fn(async () => ({ page: [{ id: 'organization-id' }] })),
		db: {
			query: vi.fn(() => ({
				first: vi.fn(async () => ({
					featureFlags: { [flagKey]: isEnabled },
					pluginCapabilityGrants: { [flagKey]: { 'send:gate': isGranted } },
				})),
			})),
		},
	};
}

describe('hosted autonomy gate authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv('POLICY_KEY', 'present');
	});

	it('authorizes only the catalogued kind owned by the requested plugin', async () => {
		const ctx = fakeContext(true, true);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'policy-pack',
				gateKind: 'plugin.policy-pack.final-review',
			})
		).resolves.toBe(true);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'other-pack',
				gateKind: 'plugin.policy-pack.final-review',
			})
		).resolves.toBe(false);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'policy-pack',
				gateKind: 'plugin.policy-pack.missing',
			})
		).resolves.toBe(false);
	});

	it.each([
		['disabled flag', false, true, 'present'],
		['missing grant', true, false, 'present'],
		['missing environment', true, true, ''],
	] as const)('denies and audits %s', async (_label, isEnabled, isGranted, key) => {
		vi.stubEnv('POLICY_KEY', key);
		await expect(
			authorizeHandler(fakeContext(isEnabled, isGranted), {
				pluginId: 'policy-pack',
				gateKind: 'plugin.policy-pack.final-review',
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'policy-pack' }),
			'autonomy.gate',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});

	it('records only trusted attribution and bounded reason codes', async () => {
		await outcomeHandler(fakeContext(true, true), {
			pluginId: 'policy-pack',
			gateKind: 'plugin.policy-pack.final-review',
			outcome: 'failed',
			reasonCode: 'autonomy_gate_timeout',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'policy-pack' }),
			'autonomy.gate',
			'failed',
			{ reasonCode: 'autonomy_gate_timeout' }
		);
	});
});
