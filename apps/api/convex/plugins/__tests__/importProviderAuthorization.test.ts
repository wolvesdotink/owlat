import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../importProviderCatalog.generated', () => ({
	BUNDLED_PLUGIN_IMPORT_PROVIDER_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.crm-pack.hubspot',
			pluginId: 'crm-pack',
			label: 'HubSpot',
			attestSource: 'hubspot',
			requiredEnvVars: Object.freeze(['HUBSPOT_KEY']),
			signature: Object.freeze({
				header: 'x-hubspot-signature',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: 'HUBSPOT_WEBHOOK_SECRET',
			}),
			requiredCapability: 'imports:provide',
		}),
		Object.freeze({
			kind: 'plugin.unregistered-pack.klaviyo',
			pluginId: 'unregistered-pack',
			label: 'Klaviyo',
			attestSource: null,
			requiredEnvVars: Object.freeze([]),
			signature: Object.freeze({
				header: 'x-sig',
				algorithm: 'hmac-sha256',
				encoding: 'hex',
				secretEnvVar: 'KLAVIYO_SECRET',
			}),
			requiredCapability: 'imports:provide',
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
				capabilities: Object.freeze(['imports:provide']),
				flag: Object.freeze({ default: false, requiredEnvVars: Object.freeze(['HUBSPOT_KEY']) }),
			}),
		}),
		// A second, fully enabled and granted plugin. It owns no catalogued
		// provider, so the ONLY thing that can deny its claim on a `crm-pack` kind
		// is the ownership check — this pins that check (dropping it re-authorizes).
		Object.freeze({
			packageName: '@acme/other-pack',
			manifest: Object.freeze({
				id: 'other-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['imports:provide']),
				flag: Object.freeze({ default: false, requiredEnvVars: Object.freeze([]) }),
			}),
		}),
	]),
}));

vi.mock('../audit', () => ({ recordHostedPluginAudit: audit }));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { authorizeStart, recordOutcome } from '../importProviderAuthorization';

const authorizeHandler = (
	authorizeStart as unknown as {
		_handler: (ctx: unknown, args: { pluginId: string; providerKind: string }) => Promise<boolean>;
	}
)._handler;
const outcomeHandler = (
	recordOutcome as unknown as {
		_handler: (
			ctx: unknown,
			args: { pluginId: string; providerKind: string; outcome: 'completed' | 'failed' }
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
					featureFlags: { [flagKey]: isEnabled, 'plugin.other-pack': isEnabled },
					pluginCapabilityGrants: {
						[flagKey]: { 'imports:provide': isGranted },
						'plugin.other-pack': { 'imports:provide': isGranted },
					},
				})),
			})),
		},
	};
}

describe('hosted import provider authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		audit.mockClear();
		vi.unstubAllEnvs();
		vi.stubEnv('HUBSPOT_KEY', 'present');
	});

	it('authorizes only the catalogued provider owned by the requesting plugin', async () => {
		const ctx = fakeContext(true, true);
		await expect(
			authorizeHandler(ctx, { pluginId: 'crm-pack', providerKind: 'plugin.crm-pack.hubspot' })
		).resolves.toBe(true);
		// Cross-plugin: `other-pack` is itself registered, flag-enabled, and
		// granted, so this denial can only come from the ownership check — not
		// from registration. The claim must never audit under `crm-pack`.
		await expect(
			authorizeHandler(ctx, { pluginId: 'other-pack', providerKind: 'plugin.crm-pack.hubspot' })
		).resolves.toBe(false);
		expect(audit).not.toHaveBeenCalled();
		// A core provider is never a plugin-authorizable kind.
		await expect(
			authorizeHandler(ctx, { pluginId: 'crm-pack', providerKind: 'mailchimp' })
		).resolves.toBe(false);
	});

	it.each([
		['disabled flag', false, true, 'present'],
		['missing grant', true, false, 'present'],
		['missing environment', true, true, ''],
	] as const)('denies and audits %s', async (_label, isEnabled, isGranted, key) => {
		vi.stubEnv('HUBSPOT_KEY', key);
		await expect(
			authorizeHandler(fakeContext(isEnabled, isGranted), {
				pluginId: 'crm-pack',
				providerKind: 'plugin.crm-pack.hubspot',
			})
		).resolves.toBe(false);
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'crm-pack' }),
			'import.provider',
			'denied',
			{ reasonCode: 'access_denied' }
		);
	});

	it('denies a catalogued provider whose plugin is no longer registered', async () => {
		await expect(
			authorizeHandler(fakeContext(true, true), {
				pluginId: 'unregistered-pack',
				providerKind: 'plugin.unregistered-pack.klaviyo',
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
				providerKind: 'plugin.crm-pack.hubspot',
			})
		).resolves.toBe(false);
		expect(audit).not.toHaveBeenCalled();
	});

	it('records only trusted attribution and a bounded failure reason', async () => {
		await outcomeHandler(fakeContext(true, true), {
			pluginId: 'crm-pack',
			providerKind: 'plugin.crm-pack.hubspot',
			outcome: 'failed',
		});
		expect(audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ pluginId: 'crm-pack' }),
			'import.provider',
			'failed',
			{ reasonCode: 'import_provider_failed' }
		);
	});
});
