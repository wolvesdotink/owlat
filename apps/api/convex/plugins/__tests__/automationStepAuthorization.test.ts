import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Execution-time authorization for a bundled automation step, mirroring the
 * agent-step precedent (`agentStepAuthorization.test.ts`). Pins the two host
 * seams the walker's `pluginStep` runner delegates to: `authorizeExecution`
 * (fail-closed, single audited attempt) and `recordOutcome` (trusted attribution
 * + bounded reason code). Env presence is enforced HERE, at execution — not at
 * add time — which is the behavior the `addStep` gating comments describe.
 */

const audit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../automations/steps/catalog', () => ({
	pluginStepCatalogEntry: (kind: string) =>
		kind === 'plugin.deliverability.notify'
			? {
					kind,
					pluginId: 'deliverability',
					localId: 'notify',
					requiredCapability: 'automation:step',
				}
			: undefined,
}));

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/deliverability',
			manifest: Object.freeze({
				id: 'deliverability',
				version: '1.0.0',
				capabilities: Object.freeze(['automation:step']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['DELIVERABILITY_KEY']),
				}),
			}),
		}),
	]),
}));

vi.mock('../audit', () => ({ recordHostedPluginAudit: audit }));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { authorizeExecution, recordOutcome } from '../automationStepAuthorization';

const authorizeHandler = (
	authorizeExecution as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; stepKind: string }) => Promise<boolean>;
	}
)._handler;
const outcomeHandler = (
	recordOutcome as unknown as {
		_handler: (
			ctx: unknown,
			args: { pluginId: string; stepKind: string; outcome: 'completed' | 'failed' }
		) => Promise<void>;
	}
)._handler;
const flagKey = 'plugin.deliverability';

function fakeContext(isEnabled: boolean, isGranted: boolean) {
	return {
		runQuery: vi.fn(async () => ({ page: [{ id: 'organization-id' }] })),
		db: {
			query: vi.fn(() => ({
				first: vi.fn(async () => ({
					featureFlags: { [flagKey]: isEnabled },
					pluginCapabilityGrants: { [flagKey]: { 'automation:step': isGranted } },
				})),
			})),
		},
	};
}

describe('hosted automation step authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv('DELIVERABILITY_KEY', 'present');
	});

	it('authorizes only the registered kind owned by the requested plugin', async () => {
		const ctx = fakeContext(true, true);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'deliverability',
				stepKind: 'plugin.deliverability.notify',
			})
		).resolves.toBe(true);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'other-pack',
				stepKind: 'plugin.deliverability.notify',
			})
		).resolves.toBe(false);
		await expect(
			authorizeHandler(ctx, {
				pluginId: 'deliverability',
				stepKind: 'plugin.deliverability.missing',
			})
		).resolves.toBe(false);
	});

	it.each([
		['disabled flag', false, true, 'present'],
		['missing grant', true, false, 'present'],
		['missing environment', true, true, ''],
	] as const)('denies and audits %s', async (_label, isEnabled, isGranted, key) => {
		vi.stubEnv('DELIVERABILITY_KEY', key);
		await expect(
			authorizeHandler(fakeContext(isEnabled, isGranted), {
				pluginId: 'deliverability',
				stepKind: 'plugin.deliverability.notify',
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'deliverability' }),
			'automation.step',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});

	it('records a completed outcome with no reason code', async () => {
		await outcomeHandler(fakeContext(true, true), {
			pluginId: 'deliverability',
			stepKind: 'plugin.deliverability.notify',
			outcome: 'completed',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'deliverability' }),
			'automation.step',
			'completed',
			{}
		);
	});

	it('records a failed outcome under the fixed reason code', async () => {
		await outcomeHandler(fakeContext(true, true), {
			pluginId: 'deliverability',
			stepKind: 'plugin.deliverability.notify',
			outcome: 'failed',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'deliverability' }),
			'automation.step',
			'failed',
			{ reasonCode: 'automation_step_failed' }
		);
	});

	it('rejects a recorded outcome with mismatched plugin attribution', async () => {
		await expect(
			outcomeHandler(fakeContext(true, true), {
				pluginId: 'other-pack',
				stepKind: 'plugin.deliverability.notify',
				outcome: 'completed',
			})
		).rejects.toThrow('Invalid bundled automation step attribution');
		expect(audit).not.toHaveBeenCalled();
	});
});
