import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../agent/steps/catalog', () => ({
	pluginAgentStepDefinition: (kind: string) =>
		kind === 'plugin.policy-pack.spam-score'
			? { kind, pluginId: 'policy-pack', requiredCapability: 'agent:step' }
			: undefined,
}));

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['agent:step']),
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
import { authorizeExecution } from '../agentStepAuthorization';

const handler = (
	authorizeExecution as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; stepKind: string }) => Promise<boolean>;
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
					pluginCapabilityGrants: { [flagKey]: { 'agent:step': isGranted } },
				})),
			})),
		},
	};
}

describe('hosted agent step authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv('POLICY_KEY', 'present');
	});

	it('authorizes only the registered kind owned by the requested plugin', async () => {
		const ctx = fakeContext(true, true);
		await expect(
			handler(ctx, {
				pluginId: 'policy-pack',
				stepKind: 'plugin.policy-pack.spam-score',
			})
		).resolves.toBe(true);
		await expect(
			handler(ctx, { pluginId: 'other-pack', stepKind: 'plugin.policy-pack.spam-score' })
		).resolves.toBe(false);
		await expect(
			handler(ctx, { pluginId: 'policy-pack', stepKind: 'plugin.policy-pack.missing' })
		).resolves.toBe(false);
	});

	it.each([
		['disabled flag', false, true, 'present'],
		['missing grant', true, false, 'present'],
		['missing environment', true, true, ''],
	] as const)('denies and audits %s', async (_label, isEnabled, isGranted, key) => {
		vi.stubEnv('POLICY_KEY', key);
		await expect(
			handler(fakeContext(isEnabled, isGranted), {
				pluginId: 'policy-pack',
				stepKind: 'plugin.policy-pack.spam-score',
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'policy-pack' }),
			'agent.step',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});
});
