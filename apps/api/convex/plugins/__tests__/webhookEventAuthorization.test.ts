import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../webhookEventCatalog.generated', () => ({
	BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.crm-pack.deal-won',
			pluginId: 'crm-pack',
			description: 'A deal was won',
			subscribable: true,
			requiredCapability: 'webhooks:publish',
		}),
		Object.freeze({
			kind: 'plugin.unregistered-pack.tick',
			pluginId: 'unregistered-pack',
			description: 'Tick',
			subscribable: false,
			requiredCapability: 'webhooks:publish',
		}),
	]),
}));

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/crm-pack',
			manifest: Object.freeze({
				id: 'crm-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['webhooks:publish']),
				flag: Object.freeze({ default: false, requiredEnvVars: Object.freeze(['CRM_KEY']) }),
			}),
		}),
	]),
}));

vi.mock('../audit', () => ({ recordHostedPluginAudit: audit }));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { authorizePublish, recordOutcome } from '../webhookEventAuthorization';

const authorizeHandler = (
	authorizePublish as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; eventKind: string }) => Promise<boolean>;
	}
)._handler;
const outcomeHandler = (
	recordOutcome as unknown as {
		_handler: (
			ctx: unknown,
			args: { pluginId: string; eventKind: string; outcome: 'completed' | 'failed' }
		) => Promise<void>;
	}
)._handler;
const flagKey = 'plugin.crm-pack';

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
					pluginCapabilityGrants: { [flagKey]: { 'webhooks:publish': isGranted } },
				})),
			})),
		},
	};
}

describe('hosted webhook event authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv('CRM_KEY', 'present');
	});

	it('authorizes only the catalogued kind owned by the requesting plugin', async () => {
		const ctx = fakeContext(true, true);
		await expect(
			authorizeHandler(ctx, { pluginId: 'crm-pack', eventKind: 'plugin.crm-pack.deal-won' })
		).resolves.toBe(true);
		// Cross-plugin: a different plugin claiming crm-pack's event.
		await expect(
			authorizeHandler(ctx, { pluginId: 'other-pack', eventKind: 'plugin.crm-pack.deal-won' })
		).resolves.toBe(false);
		// A core event is never a plugin-publishable kind.
		await expect(
			authorizeHandler(ctx, { pluginId: 'crm-pack', eventKind: 'email.sent' })
		).resolves.toBe(false);
	});

	it.each([
		['disabled flag', false, true, 'present'],
		['missing grant', true, false, 'present'],
		['missing environment', true, true, ''],
	] as const)('denies and audits %s', async (_label, isEnabled, isGranted, key) => {
		vi.stubEnv('CRM_KEY', key);
		await expect(
			authorizeHandler(fakeContext(isEnabled, isGranted), {
				pluginId: 'crm-pack',
				eventKind: 'plugin.crm-pack.deal-won',
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'crm-pack' }),
			'webhook.publish',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});

	it('denies a catalogued event whose plugin is no longer registered', async () => {
		await expect(
			authorizeHandler(fakeContext(true, true), {
				pluginId: 'unregistered-pack',
				eventKind: 'plugin.unregistered-pack.tick',
			})
		).resolves.toBe(false);
	});

	it.each([
		['zero organizations', []],
		['multiple organizations', [{ id: 'org-one' }, { id: 'org-two' }]],
	] as const)('denies safely with %s and never audits', async (_label, organizations) => {
		await expect(
			authorizeHandler(fakeContext(true, true, organizations), {
				pluginId: 'crm-pack',
				eventKind: 'plugin.crm-pack.deal-won',
			})
		).resolves.toBe(false);
		expect(audit).not.toHaveBeenCalled();
	});

	it('records only trusted attribution and a bounded failure reason', async () => {
		await outcomeHandler(fakeContext(true, true), {
			pluginId: 'crm-pack',
			eventKind: 'plugin.crm-pack.deal-won',
			outcome: 'failed',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'crm-pack' }),
			'webhook.publish',
			'failed',
			{ reasonCode: 'webhook_publish_failed' }
		);
	});
});
