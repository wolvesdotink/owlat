import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/mail-pack',
			manifest: Object.freeze({
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['POSTMARK_TOKEN']),
				}),
			}),
		}),
	]),
}));

import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { authorizeSystemBundledPlugin } from '../authorization';

const flagKey = 'plugin.mail-pack';

function fakeContext(settings: unknown) {
	return {
		runQuery: vi.fn(async () => ({ page: [{ id: 'organization-id' }] })),
		db: {
			query: vi.fn(() => ({ first: vi.fn(async () => settings) })),
		},
	};
}

describe('system bundled-plugin authorization', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('POSTMARK_TOKEN', 'present');
	});

	it('returns a bounded system scope only when flag, declaration, grant, env, and singleton pass', async () => {
		const ctx = fakeContext({
			featureFlags: { [flagKey]: true },
			pluginCapabilityGrants: { [flagKey]: { 'send:transport': true } },
		});
		await expect(
			authorizeSystemBundledPlugin(ctx as never, 'mail-pack', 'send:transport')
		).resolves.toMatchObject({
			organizationId: 'organization-id',
			userId: 'system:bundled_plugin',
			pluginId: 'mail-pack',
		});
	});

	it.each([
		['disabled flag', false, true, 'present'],
		['missing grant', true, false, 'present'],
		['missing environment', true, true, ''],
	] as const)('denies a plugin with %s', async (_case, isEnabled, isGranted, token) => {
		vi.stubEnv('POSTMARK_TOKEN', token);
		const ctx = fakeContext({
			featureFlags: { [flagKey]: isEnabled },
			pluginCapabilityGrants: { [flagKey]: { 'send:transport': isGranted } },
		});
		await expect(
			authorizeSystemBundledPlugin(ctx as never, 'mail-pack', 'send:transport')
		).resolves.toBeNull();
	});

	it('denies malformed, unbundled, and undeclared capability requests', async () => {
		const ctx = fakeContext({
			featureFlags: { [flagKey]: true },
			pluginCapabilityGrants: { [flagKey]: { 'send:transport': true } },
		});
		await expect(
			authorizeSystemBundledPlugin(ctx as never, '../mail-pack', 'send:transport')
		).resolves.toBeNull();
		await expect(
			authorizeSystemBundledPlugin(ctx as never, 'not-bundled', 'send:transport')
		).resolves.toBeNull();
		await expect(
			authorizeSystemBundledPlugin(ctx as never, 'mail-pack', 'mail:write')
		).resolves.toBeNull();
	});
});
