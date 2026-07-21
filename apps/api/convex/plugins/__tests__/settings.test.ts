import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../_generated/api';
import schema from '../../schema';

const auth = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'editor' }));

// Gate the settings surface authentically: `getMutationContext` (authedMutation
// floor) and `requireOrgPermission` (adminQuery floor) reject anonymous callers;
// `requireAdminContext`/`requireOrgPermission` additionally reject non-admins.
vi.mock('../../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../../lib/sessionOrganization')),
	getMutationContext: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		return { userId: 'owner', role: auth.role, activeOrganizationId: 'tenant-a' };
	}),
	requireAdminContext: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		if (auth.role === 'editor') throw new Error('forbidden');
		return { userId: 'owner', role: auth.role, activeOrganizationId: 'tenant-a' };
	}),
	requireOrgPermission: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		if (auth.role === 'editor') throw new Error('forbidden');
		return { userId: 'owner', role: auth.role, activeOrganizationId: 'tenant-a' };
	}),
}));

// A bundled plugin exercising every settings-field kind plus a secret. The
// composition also feeds featureFlagRegistry, so `plugin.policy-pack` resolves.
vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/policy-pack',
			manifest: Object.freeze({
				id: 'policy-pack',
				version: '1.2.0',
				capabilities: Object.freeze(['mail:read', 'send:gate']),
				flag: Object.freeze({ default: false }),
				settingsSchema: Object.freeze([
					Object.freeze({
						kind: 'string',
						key: 'endpoint',
						label: 'Endpoint',
						default: 'https://api.test',
					}),
					Object.freeze({
						kind: 'secret',
						key: 'apiKey',
						envVar: 'PLUGIN_POLICY_PACK_API_KEY',
						label: 'API key',
						required: true,
					}),
					Object.freeze({
						kind: 'number',
						key: 'timeout',
						label: 'Timeout',
						default: 30,
						min: 1,
						max: 120,
					}),
				]),
			}),
		}),
	]),
}));

const rootGlob = import.meta.glob('../../**/*.*s');
const pluginGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../plugins/'),
		module,
	])
);
const modules = { ...rootGlob, ...pluginGlob };
const identity = {
	subject: 'owner',
	issuer: 'https://test.issuer.example',
	tokenIdentifier: 'https://test.issuer.example|owner',
};
const FLAG_KEY = 'plugin.policy-pack';

beforeEach(() => {
	auth.role = 'owner';
});

async function readStoredSettings(t: { run: ReturnType<typeof convexTest>['run'] }) {
	return await t.run(async (ctx) => {
		const row = await ctx.db.query('instanceSettings').first();
		return row?.pluginSettings ?? null;
	});
}

describe('plugins.settings authorization', () => {
	it('rejects anonymous reads and writes', async () => {
		const anonymous = convexTest(schema, modules);
		await expect(
			anonymous.query(api.plugins.settings.getPluginSettingsOverview, {})
		).rejects.toThrow('unauthenticated');
		await expect(
			anonymous.mutation(api.plugins.settings.setPluginSettings, {
				pluginId: 'policy-pack',
				values: { endpoint: 'https://x' },
			})
		).rejects.toThrow('unauthenticated');
	});

	it('rejects a non-admin member and writes nothing', async () => {
		auth.role = 'editor';
		const member = convexTest(schema, modules).withIdentity(identity);
		await expect(member.query(api.plugins.settings.getPluginSettingsOverview, {})).rejects.toThrow(
			'forbidden'
		);
		await expect(
			member.mutation(api.plugins.settings.setPluginSettings, {
				pluginId: 'policy-pack',
				values: { apiKey: 'nope' },
			})
		).rejects.toThrow('forbidden');
		expect(await readStoredSettings(member)).toBeNull();
	});
});

describe('getPluginSettingsOverview', () => {
	it('lists each bundled plugin with grants, enablement, and schema defaults', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { [FLAG_KEY]: true },
				pluginCapabilityGrants: { [FLAG_KEY]: { 'mail:read': true } },
				createdAt: Date.now(),
			});
		});

		const overview = await t.query(api.plugins.settings.getPluginSettingsOverview, {});
		expect(overview.plugins).toHaveLength(1);
		const plugin = overview.plugins[0]!;
		expect(plugin).toMatchObject({
			pluginId: 'policy-pack',
			packageName: '@example/policy-pack',
			version: '1.2.0',
			flagKey: FLAG_KEY,
			enabled: true,
			hasSettings: true,
		});
		expect(plugin.capabilities).toEqual([
			{ capability: 'mail:read', granted: true },
			{ capability: 'send:gate', granted: false },
		]);
		// Non-secret defaults surface; the secret shows only its presence.
		expect(plugin.values).toEqual({ endpoint: 'https://api.test', timeout: 30 });
		expect(plugin.secretsSet).toEqual({ apiKey: false });
	});

	it('surfaces residual settings of a removed plugin as orphaned', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				pluginSettings: { 'plugin.removed-pack': { leftover: 'x' } },
				createdAt: Date.now(),
			});
		});
		const overview = await t.query(api.plugins.settings.getPluginSettingsOverview, {});
		expect(overview.orphaned).toEqual([
			{ flagKey: 'plugin.removed-pack', pluginId: 'removed-pack' },
		]);
	});
});

describe('setPluginSettings', () => {
	it('never writes a secret to the row, and refuses the whole save that carries one', async () => {
		// The proving assertion for the cleartext-at-rest finding: after a save that
		// tries to set a secret, no document anywhere holds the plaintext.
		const t = convexTest(schema, modules).withIdentity(identity);
		await expect(
			t.mutation(api.plugins.settings.setPluginSettings, {
				pluginId: 'policy-pack',
				values: { endpoint: 'https://prod.example', timeout: 45, apiKey: 'super-secret-token' },
			})
		).rejects.toThrow(/PLUGIN_POLICY_PACK_API_KEY/);

		const document = await t.run(async (ctx) => ctx.db.query('instanceSettings').first());
		expect(JSON.stringify(document ?? {})).not.toContain('super-secret-token');
		expect(await readStoredSettings(t)).toBeNull();
	});

	it('persists the non-secret values on their own', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const result = await t.mutation(api.plugins.settings.setPluginSettings, {
			pluginId: 'policy-pack',
			values: { endpoint: 'https://prod.example', timeout: 45 },
		});
		expect(result.values).toEqual({ endpoint: 'https://prod.example', timeout: 45 });
		// The env var is unset in this test deployment, so the secret reads unset.
		expect(result.secretsSet).toEqual({ apiKey: false });
		const stored = await readStoredSettings(t);
		expect(stored?.[FLAG_KEY]).toEqual({ endpoint: 'https://prod.example', timeout: 45 });
		await t.run(async (ctx) => {
			const audit = await ctx.db.query('auditLogs').first();
			expect(audit).toMatchObject({
				organizationId: 'tenant-a',
				pluginId: 'policy-pack',
				action: 'settings.updated',
			});
		});
	});

	it('sweeps residual secret plaintext left by an older deployment on the next save', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		// The shape a deployment that stored secrets would leave behind, plus a key
		// the current schema no longer declares at all.
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				pluginSettings: {
					[FLAG_KEY]: { apiKey: 'stale-secret', legacyToken: 'orphan-plaintext' },
				},
				createdAt: Date.now(),
			});
		});
		await t.mutation(api.plugins.settings.setPluginSettings, {
			pluginId: 'policy-pack',
			values: { endpoint: 'https://prod.example' },
		});
		const stored = await readStoredSettings(t);
		expect(stored?.[FLAG_KEY]).toEqual({ endpoint: 'https://prod.example' });
		const document = await t.run(async (ctx) => ctx.db.query('instanceSettings').first());
		expect(JSON.stringify(document ?? {})).not.toContain('stale-secret');
		expect(JSON.stringify(document ?? {})).not.toContain('orphan-plaintext');
	});

	it('rejects an unknown field and writes nothing', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await expect(
			t.mutation(api.plugins.settings.setPluginSettings, {
				pluginId: 'policy-pack',
				values: { nope: 'x' },
			})
		).rejects.toThrow(/Invalid plugin settings/);
		expect(await readStoredSettings(t)).toBeNull();
	});

	it('rejects an out-of-range number', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await expect(
			t.mutation(api.plugins.settings.setPluginSettings, {
				pluginId: 'policy-pack',
				values: { timeout: 9999 },
			})
		).rejects.toThrow(/Invalid plugin settings/);
	});

	it('rejects an id that is not a bundled plugin', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await expect(
			t.mutation(api.plugins.settings.setPluginSettings, {
				pluginId: 'ghost',
				values: { endpoint: 'https://x' },
			})
		).rejects.toThrow(/not installed/);
	});
});

describe('resetPluginSettings', () => {
	it('clears stored values back to schema defaults', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.mutation(api.plugins.settings.setPluginSettings, {
			pluginId: 'policy-pack',
			values: { endpoint: 'https://prod.example' },
		});
		const result = await t.mutation(api.plugins.settings.resetPluginSettings, {
			pluginId: 'policy-pack',
		});
		expect(result.values).toEqual({ endpoint: 'https://api.test', timeout: 30 });
		expect(result.secretsSet).toEqual({ apiKey: false });
		const stored = await readStoredSettings(t);
		expect(stored?.[FLAG_KEY]).toBeUndefined();
	});

	it('purges residual settings of a removed plugin', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				pluginSettings: { 'plugin.removed-pack': { leftover: 'x' } },
				createdAt: Date.now(),
			});
		});
		await t.mutation(api.plugins.settings.resetPluginSettings, { pluginId: 'removed-pack' });
		const stored = await readStoredSettings(t);
		expect(stored?.['plugin.removed-pack']).toBeUndefined();
	});

	it('is idempotent when nothing is stored', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const result = await t.mutation(api.plugins.settings.resetPluginSettings, {
			pluginId: 'policy-pack',
		});
		expect(result.values).toEqual({ endpoint: 'https://api.test', timeout: 30 });
	});
});
