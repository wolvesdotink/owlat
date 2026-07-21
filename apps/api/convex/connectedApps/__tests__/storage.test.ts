import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCapability } from '@owlat/plugin-kit';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { bindConnectedAppStorage } from '../storage';

const READ = 'plugin-storage:read' as PluginCapability;
const WRITE = 'plugin-storage:write' as PluginCapability;
const ALL_CAPS = [READ, WRITE];

vi.mock('../../plugins/plugins.generated', () => ({
	bundledPluginComposition: ['alpha', 'beta'].map((id) => ({
		packageName: `@example/${id}`,
		manifest: {
			id,
			version: '1.0.0',
			capabilities: ['plugin-storage:read', 'plugin-storage:write'],
			flag: { default: false },
		},
	})),
}));

const rootGlob = import.meta.glob('../../**/*.*s');
const localGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../connectedApps/'),
		mod,
	])
);
const modules = { ...rootGlob, ...localGlob };

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>['run']>[0]>[0];

beforeEach(() => vi.stubEnv('INSTANCE_SECRET', 'connected-app-storage-test-secret'));
afterEach(() => vi.unstubAllEnvs());

/** Grant a bundled plugin its flag + a set of capabilities in instanceSettings. */
async function operatorGrant(
	ctx: Ctx,
	pluginId: string,
	allowed: readonly PluginCapability[] = ALL_CAPS
): Promise<void> {
	const existing = await ctx.db.query('instanceSettings').first();
	const flag = `plugin.${pluginId}`;
	const next = {
		featureFlags: { ...existing?.featureFlags, [flag]: true },
		pluginCapabilityGrants: {
			...existing?.pluginCapabilityGrants,
			[flag]: Object.fromEntries(allowed.map((c) => [c, true])),
		},
		updatedAt: Date.now(),
	};
	if (existing) await ctx.db.patch(existing._id, next);
	else await ctx.db.insert('instanceSettings', { ...next, createdAt: Date.now() });
}

async function seedApp(
	ctx: Ctx,
	opts: {
		organizationId: string;
		pluginId: string;
		status?: 'enabled' | 'disabled' | 'revoked';
		grants?: readonly PluginCapability[];
	}
): Promise<Id<'connectedApps'>> {
	const now = Date.now();
	return ctx.db.insert('connectedApps', {
		organizationId: opts.organizationId,
		pluginId: opts.pluginId,
		name: `${opts.pluginId} app`,
		endpointUrl: 'https://hooks.example.com/x',
		status: opts.status ?? 'enabled',
		grantedCapabilities: (opts.grants ?? ALL_CAPS) as string[],
		secretCiphertext: 'c',
		secretIv: 'i',
		secretAuthTag: 't',
		secretEnvelopeVersion: 1,
		secretRotatedAt: now,
		createdByUserId: 'seed',
		createdAt: now,
		updatedAt: now,
	});
}

describe('connected-app host-mediated storage', () => {
	it('lets an enabled app read and write its own scoped namespace', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha');
			const appId = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha' });
			const store = await bindConnectedAppStorage(ctx, appId, 'tenant-a');
			await store.set('greeting', { hello: 'world' });
			expect(await store.get('greeting')).toEqual({ hello: 'world' });
			expect(await store.list()).toEqual({ keys: ['greeting'] });
			await store.delete('greeting');
			expect(await store.get('greeting')).toBeUndefined();
		});
	});

	it('isolates storage across tenants and across apps on different plugins', async () => {
		const t = convexTest(schema, modules);
		let a: Id<'connectedApps'>, bSameTenant: Id<'connectedApps'>, aOtherTenant: Id<'connectedApps'>;
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha');
			await operatorGrant(ctx, 'beta');
			a = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha' });
			bSameTenant = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'beta' });
			aOtherTenant = await seedApp(ctx, { organizationId: 'tenant-b', pluginId: 'alpha' });
			await (await bindConnectedAppStorage(ctx, a, 'tenant-a')).set('k', { v: 'alpha-a' });
			await (await bindConnectedAppStorage(ctx, bSameTenant, 'tenant-a')).set('k', { v: 'beta-a' });
			await (
				await bindConnectedAppStorage(ctx, aOtherTenant, 'tenant-b')
			).set('k', { v: 'alpha-b' });
		});
		await t.run(async (ctx) => {
			// Cross-plugin (same tenant): distinct namespaces.
			expect(await (await bindConnectedAppStorage(ctx, a, 'tenant-a')).get('k')).toEqual({
				v: 'alpha-a',
			});
			expect(await (await bindConnectedAppStorage(ctx, bSameTenant, 'tenant-a')).get('k')).toEqual({
				v: 'beta-a',
			});
			// Cross-tenant (same plugin): distinct namespaces.
			expect(await (await bindConnectedAppStorage(ctx, aOtherTenant, 'tenant-b')).get('k')).toEqual(
				{
					v: 'alpha-b',
				}
			);
		});
	});

	it('shares one namespace across two apps bound to the same plugin in the same tenant', async () => {
		// Storage scope is keyed by (organizationId, pluginId), NOT connectedAppId:
		// a connected app's KV IS its bound plugin's scoped namespace, so two apps on
		// the same plugin+tenant deliberately read and write the SAME namespace. This
		// pins that intended cross-app sharing so a later refactor cannot silently
		// flip it to per-app isolation.
		const t = convexTest(schema, modules);
		let appA: Id<'connectedApps'>, appB: Id<'connectedApps'>;
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha');
			appA = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha' });
			appB = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha' });
			await (await bindConnectedAppStorage(ctx, appA, 'tenant-a')).set('k', { v: 'from-a' });
		});
		await t.run(async (ctx) => {
			// App B reads the value app A wrote (shared plugin-scoped namespace)…
			expect(await (await bindConnectedAppStorage(ctx, appB, 'tenant-a')).get('k')).toEqual({
				v: 'from-a',
			});
			// …and app B can overwrite it, which app A then observes.
			await (await bindConnectedAppStorage(ctx, appB, 'tenant-a')).set('k', { v: 'from-b' });
			expect(await (await bindConnectedAppStorage(ctx, appA, 'tenant-a')).get('k')).toEqual({
				v: 'from-b',
			});
		});
	});

	it('denies binding with a foreign tenant id', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha');
			const appId = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha' });
			await expect(bindConnectedAppStorage(ctx, appId, 'tenant-b')).rejects.toMatchObject({
				code: 'access_denied',
			});
		});
	});

	it.each(['disabled', 'revoked'] as const)('denies a %s app', async (status) => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha');
			const appId = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha', status });
			await expect(bindConnectedAppStorage(ctx, appId, 'tenant-a')).rejects.toMatchObject({
				code: 'access_denied',
			});
		});
	});

	it('denies a capability the app did not request even when the operator granted it', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha', ALL_CAPS);
			const appId = await seedApp(ctx, {
				organizationId: 'tenant-a',
				pluginId: 'alpha',
				grants: [READ],
			});
			const store = await bindConnectedAppStorage(ctx, appId, 'tenant-a');
			await expect(store.set('k', true)).rejects.toMatchObject({ code: 'access_denied' });
			// The read the app DID request still works.
			expect(await store.get('k')).toBeUndefined();
		});
	});

	it('denies a capability the operator did not grant even when the app requested it', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			// Operator granted only read at the plugin level; app requested both.
			await operatorGrant(ctx, 'alpha', [READ]);
			const appId = await seedApp(ctx, {
				organizationId: 'tenant-a',
				pluginId: 'alpha',
				grants: ALL_CAPS,
			});
			const store = await bindConnectedAppStorage(ctx, appId, 'tenant-a');
			await expect(store.set('k', true)).rejects.toMatchObject({ code: 'access_denied' });
		});
	});

	it('fails closed the moment the app is disabled mid-session', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha');
			const appId = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha' });
			const store = await bindConnectedAppStorage(ctx, appId, 'tenant-a');
			await store.set('k', 1);
			await ctx.db.patch(appId, { status: 'disabled' });
			await expect(store.get('k')).rejects.toMatchObject({ code: 'access_denied' });
			await expect(store.set('k', 2)).rejects.toMatchObject({ code: 'access_denied' });
		});
	});

	it('audits storage operations with plugin attribution and no secret', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await operatorGrant(ctx, 'alpha');
			const appId = await seedApp(ctx, { organizationId: 'tenant-a', pluginId: 'alpha' });
			const store = await bindConnectedAppStorage(ctx, appId, 'tenant-a');
			await store.set('SECRET_KEY', { token: 'SECRET_VALUE' });
			const rows = await ctx.db.query('auditLogs').collect();
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.organizationId === 'tenant-a' && r.pluginId === 'alpha')).toBe(
				true
			);
			expect(rows.some((r) => r.userId === `connected_app:${appId}`)).toBe(true);
			expect(JSON.stringify(rows)).not.toContain('SECRET_VALUE');
		});
	});
});
