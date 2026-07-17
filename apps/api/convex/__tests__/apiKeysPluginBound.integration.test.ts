import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';

/**
 * PP-21 (Tier 2): plugin-bound API keys. Covers creation binding (the manifest
 * ceiling + operator-grant restriction enforced at mint time), rejection of a
 * key bound to an unavailable plugin, and one-click revocation by pluginId.
 *
 * A mock composition supplies one installed bundled plugin so `create` can
 * resolve a manifest + flag; the org-permission gate is mocked open the same
 * way the sibling apiKeysCreate.integration test does.
 */
vi.mock('../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/connector',
			manifest: Object.freeze({
				id: 'acme-connector',
				version: '1.0.0',
				capabilities: Object.freeze(['contacts:read', 'contacts:write', 'mail:read']),
				flag: Object.freeze({ default: false }),
			}),
		}),
	]),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-user', role: 'owner' }),
	};
});

import schema from '../schema';
import { api } from '../_generated/api';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const testUser = { subject: 'admin-user', issuer: 'test', tokenIdentifier: 'test|admin-user' };

// The identity-scoped handle returned by `withIdentity`; helpers here only use
// `.run` / `.mutation`, both of which it exposes.
type IdentifiedTestConvex = ReturnType<ReturnType<typeof convexTest>['withIdentity']>;

async function seedInstalledPlugin(t: IdentifiedTestConvex, grants: Record<string, boolean>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { 'plugin.acme-connector': true },
			pluginCapabilityGrants: { 'plugin.acme-connector': grants },
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe('apiKeys.create — plugin binding', () => {
	it('mints a bound key whose scopes fall within the granted subset', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await seedInstalledPlugin(t, { 'contacts:read': true, 'mail:read': true });
		const result = await t.mutation(api.auth.apiKeys.create, {
			name: 'acme key',
			scopes: ['contacts:read', 'mail:read'],
			pluginId: 'acme-connector',
		});
		const stored = await t.run(async (ctx) => ctx.db.get(result.keyId));
		expect(stored?.pluginId).toBe('acme-connector');
		expect(stored?.scopes).toEqual(['contacts:read', 'mail:read']);
	});

	it('rejects a bound key requesting a scope the operator did not grant', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await seedInstalledPlugin(t, { 'contacts:read': true });
		await expect(
			t.mutation(api.auth.apiKeys.create, {
				name: 'over-broad',
				scopes: ['contacts:read', 'contacts:write'],
				pluginId: 'acme-connector',
			})
		).rejects.toThrow(/has not been granted/);
	});

	it('rejects a bound key requesting a scope the manifest never declared', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		// events:write is a real ApiScope but is not in this plugin's manifest, so
		// even granting it cannot lift it above the manifest ceiling.
		await seedInstalledPlugin(t, { 'contacts:read': true, 'events:write': true });
		await expect(
			t.mutation(api.auth.apiKeys.create, {
				name: 'undeclared',
				scopes: ['events:write'],
				pluginId: 'acme-connector',
			})
		).rejects.toThrow(/has not been granted/);
	});

	it('rejects binding to a plugin that is installed but disabled', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { 'plugin.acme-connector': false },
				pluginCapabilityGrants: { 'plugin.acme-connector': { 'contacts:read': true } },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		await expect(
			t.mutation(api.auth.apiKeys.create, {
				name: 'disabled',
				scopes: ['contacts:read'],
				pluginId: 'acme-connector',
			})
		).rejects.toThrow(/not installed and enabled/);
	});

	it('rejects binding to an unknown plugin', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await seedInstalledPlugin(t, { 'contacts:read': true });
		await expect(
			t.mutation(api.auth.apiKeys.create, {
				name: 'ghost',
				scopes: ['contacts:read'],
				pluginId: 'ghost-plugin',
			})
		).rejects.toThrow(/not installed and enabled/);
	});

	it('rejects an unparseable pluginId', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await seedInstalledPlugin(t, { 'contacts:read': true });
		await expect(
			t.mutation(api.auth.apiKeys.create, {
				name: 'bad id',
				scopes: ['contacts:read'],
				pluginId: 'Not A Valid Id!',
			})
		).rejects.toThrow(/Invalid pluginId/);
	});
});

describe('apiKeys.revokeByPlugin — one-click revocation', () => {
	async function seedKey(
		t: IdentifiedTestConvex,
		fields: { pluginId?: string; isActive: boolean; name: string }
	) {
		return t.run(async (ctx) =>
			ctx.db.insert('apiKeys', {
				name: fields.name,
				keyHash: `hash-${fields.name}`,
				keyPrefix: 'lm_live_',
				scopes: ['contacts:read'],
				...(fields.pluginId !== undefined ? { pluginId: fields.pluginId } : {}),
				isActive: fields.isActive,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
	}

	it('revokes every active key bound to the plugin and leaves others untouched', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const boundA = await seedKey(t, { pluginId: 'acme-connector', isActive: true, name: 'a' });
		const boundB = await seedKey(t, { pluginId: 'acme-connector', isActive: true, name: 'b' });
		const otherPlugin = await seedKey(t, { pluginId: 'other-plugin', isActive: true, name: 'c' });
		const standalone = await seedKey(t, { isActive: true, name: 'd' });

		const res = await t.mutation(api.auth.apiKeys.revokeByPlugin, { pluginId: 'acme-connector' });
		expect(res.revoked).toBe(2);

		const rows = await t.run(async (ctx) => ({
			a: await ctx.db.get(boundA),
			b: await ctx.db.get(boundB),
			other: await ctx.db.get(otherPlugin),
			standalone: await ctx.db.get(standalone),
		}));
		expect(rows.a?.isActive).toBe(false);
		expect(rows.a?.revokedAt).toBeTypeOf('number');
		expect(rows.b?.isActive).toBe(false);
		expect(rows.other?.isActive).toBe(true);
		expect(rows.standalone?.isActive).toBe(true);
	});

	it('is idempotent — a second call revokes nothing', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await seedKey(t, { pluginId: 'acme-connector', isActive: true, name: 'a' });
		await t.mutation(api.auth.apiKeys.revokeByPlugin, { pluginId: 'acme-connector' });
		const second = await t.mutation(api.auth.apiKeys.revokeByPlugin, {
			pluginId: 'acme-connector',
		});
		expect(second.revoked).toBe(0);
	});

	it('returns zero for a plugin with no keys', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const res = await t.mutation(api.auth.apiKeys.revokeByPlugin, { pluginId: 'acme-connector' });
		expect(res.revoked).toBe(0);
	});

	it('rejects an unparseable pluginId', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await expect(
			t.mutation(api.auth.apiKeys.revokeByPlugin, { pluginId: 'Not Valid!' })
		).rejects.toThrow(/Invalid pluginId/);
	});
});
