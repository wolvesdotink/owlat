import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginCapability, PluginStorageService } from '@owlat/plugin-kit';
import schema from '../../schema';
import {
	bindAuthenticatedBundledPluginStorage,
	PLUGIN_STORAGE_READ_CAPABILITY,
	PLUGIN_STORAGE_WRITE_CAPABILITY,
	PluginStorageError,
} from '../storage';
import {
	encodePluginStorageValue,
	PLUGIN_STORAGE_LIMITS,
	pluginStorageEntryBytes,
} from '../storageJson';

const modules = import.meta.glob('../../**/*.*s');

type TestContext = Parameters<Parameters<ReturnType<typeof convexTest>['run']>[0]>[0];

const authentication = vi.hoisted(() => ({ organizationId: 'tenant', isMember: true }));
const registry = vi.hoisted(() => ({
	plugins: ['alpha', 'beta', 'sensitive-plugin'].map((id) => ({
		packageName: `test-${id}`,
		manifest: {
			id,
			version: '1.0.0',
			capabilities: ['plugin-storage:read', 'plugin-storage:write'],
			flag: { default: false },
		},
	})),
}));

vi.mock('../../lib/sessionOrganization', () => ({
	getBetterAuthSessionWithRole: vi.fn(async () =>
		authentication.isMember
			? {
					userId: 'test-user',
					activeOrganizationId: authentication.organizationId,
					role: 'owner',
				}
			: null
	),
}));

vi.mock('../plugins.generated', () => ({
	bundledPluginComposition: registry.plugins,
}));

async function authorizePlugin(
	ctx: TestContext,
	pluginId: string,
	allowed: ReadonlySet<PluginCapability> = new Set([
		PLUGIN_STORAGE_READ_CAPABILITY,
		PLUGIN_STORAGE_WRITE_CAPABILITY,
	])
): Promise<void> {
	const existing = await ctx.db.query('instanceSettings').first();
	const flag = `plugin.${pluginId}`;
	const next = {
		featureFlags: { ...existing?.featureFlags, [flag]: true },
		pluginCapabilityGrants: {
			...existing?.pluginCapabilityGrants,
			[flag]: Object.fromEntries([...allowed].map((capability) => [capability, true])),
		},
		updatedAt: Date.now(),
	};
	if (existing) await ctx.db.patch(existing._id, next);
	else await ctx.db.insert('instanceSettings', { ...next, createdAt: Date.now() });
}

async function storage(
	ctx: TestContext,
	organizationId: string,
	pluginId: string,
	allowed?: ReadonlySet<PluginCapability>
): Promise<PluginStorageService> {
	authentication.organizationId = organizationId;
	await authorizePlugin(ctx, pluginId, allowed);
	return bindAuthenticatedBundledPluginStorage(ctx, pluginId);
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'plugin-storage-test-secret');
	authentication.organizationId = 'tenant';
	authentication.isMember = true;
	registry.plugins.splice(
		0,
		registry.plugins.length,
		...['alpha', 'beta', 'sensitive-plugin'].map((id) => ({
			packageName: `test-${id}`,
			manifest: {
				id,
				version: '1.0.0',
				capabilities: ['plugin-storage:read', 'plugin-storage:write'],
				flag: { default: false },
			},
		}))
	);
});
afterEach(() => vi.unstubAllEnvs());

describe('scoped plugin storage', () => {
	it('isolates the same key across plugins and tenants without caller-selectable scope', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await (await storage(ctx, 'tenant-a', 'alpha')).set('shared', { owner: 'alpha' });
			await (await storage(ctx, 'tenant-a', 'beta')).set('shared', { owner: 'beta' });
			await (await storage(ctx, 'tenant-b', 'alpha')).set('shared', { owner: 'tenant-b' });
		});

		await t.run(async (ctx) => {
			expect(await (await storage(ctx, 'tenant-a', 'alpha')).get('shared')).toEqual({
				owner: 'alpha',
			});
			expect(await (await storage(ctx, 'tenant-a', 'beta')).get('shared')).toEqual({
				owner: 'beta',
			});
			expect(await (await storage(ctx, 'tenant-b', 'alpha')).get('shared')).toEqual({
				owner: 'tenant-b',
			});
			expect(await (await storage(ctx, 'tenant-a', 'alpha')).list()).toEqual({ keys: ['shared'] });
		});
	});

	it.each([
		['get', PLUGIN_STORAGE_WRITE_CAPABILITY],
		['list', PLUGIN_STORAGE_WRITE_CAPABILITY],
		['set', PLUGIN_STORAGE_READ_CAPABILITY],
		['delete', PLUGIN_STORAGE_READ_CAPABILITY],
	] as const)('denies %s without its exact capability', async (operation, capability) => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant', 'alpha', new Set([capability]));
			const call =
				operation === 'get'
					? service.get('key')
					: operation === 'list'
						? service.list()
						: operation === 'set'
							? service.set('key', true)
							: service.delete('key');
			await expect(call).rejects.toMatchObject({ code: 'access_denied' });
		});
	});

	it('rechecks enabled, registered, and grant state for every operation', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant', 'alpha');
			await service.set('key', true);
			const settings = await ctx.db.query('instanceSettings').unique();
			const operations = [
				[PLUGIN_STORAGE_READ_CAPABILITY, () => service.get('key')],
				[PLUGIN_STORAGE_READ_CAPABILITY, () => service.list()],
				[PLUGIN_STORAGE_WRITE_CAPABILITY, () => service.set('key', false)],
				[PLUGIN_STORAGE_WRITE_CAPABILITY, () => service.delete('key')],
			] as const;
			for (const [revokedCapability, operation] of operations) {
				const retainedCapability =
					revokedCapability === PLUGIN_STORAGE_READ_CAPABILITY
						? PLUGIN_STORAGE_WRITE_CAPABILITY
						: PLUGIN_STORAGE_READ_CAPABILITY;
				await authorizePlugin(ctx, 'alpha', new Set([retainedCapability]));
				await expect(operation()).rejects.toMatchObject({ code: 'access_denied' });
				await authorizePlugin(ctx, 'alpha');
			}
			for (const [, operation] of operations) {
				await ctx.db.patch(settings!._id, { featureFlags: { 'plugin.alpha': false } });
				await expect(operation()).rejects.toMatchObject({ code: 'access_denied' });
				await authorizePlugin(ctx, 'alpha');
			}
			registry.plugins.splice(
				registry.plugins.findIndex((plugin) => plugin.manifest.id === 'alpha'),
				1
			);
			await expect(service.get('key')).rejects.toMatchObject({ code: 'access_denied' });
		});
	});

	it('rejects a storage-capable registry entry without its required explicit flag', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			registry.plugins.push({
				packageName: 'test-unflagged',
				manifest: {
					id: 'unflagged',
					version: '1.0.0',
					capabilities: ['plugin-storage:read', 'plugin-storage:write'],
				} as (typeof registry.plugins)[number]['manifest'],
			});
			await authorizePlugin(ctx, 'unflagged');
			await expect(bindAuthenticatedBundledPluginStorage(ctx, 'unflagged')).rejects.toMatchObject({
				code: 'access_denied',
			});
		});
	});

	it('tracks UTF-8 key plus canonical value bytes through grow, shrink, and delete', async () => {
		const t = convexTest(schema, modules);
		const key = '😀'.repeat(32);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant', 'alpha');
			await service.set(key, 'x');
			let usage = await ctx.db.query('pluginStorageUsage').unique();
			expect(usage).toMatchObject({
				entryCount: 1,
				totalStoredBytes: pluginStorageEntryBytes(key, encodePluginStorageValue('x').bytes),
			});

			await service.set(key, 'x'.repeat(1_000));
			usage = await ctx.db.query('pluginStorageUsage').unique();
			expect(usage?.totalStoredBytes).toBe(
				pluginStorageEntryBytes(key, encodePluginStorageValue('x'.repeat(1_000)).bytes)
			);
			await service.set(key, '');
			usage = await ctx.db.query('pluginStorageUsage').unique();
			expect(usage?.totalStoredBytes).toBe(
				pluginStorageEntryBytes(key, encodePluginStorageValue('').bytes)
			);

			await service.delete(key);
			await service.delete(key);
			expect(await ctx.db.query('pluginStorageEntries').unique()).toBeNull();
			expect(await ctx.db.query('pluginStorageUsage').unique()).toBeNull();
		});
	});

	it('allows the exact total-byte quota and rejects one byte beyond it atomically', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant', 'alpha');
			const key = 'target';
			const value = 'x';
			const targetBytes = pluginStorageEntryBytes(key, encodePluginStorageValue(value).bytes);
			const now = Date.now();
			await ctx.db.insert('pluginStorageEntries', {
				organizationId: 'tenant',
				pluginId: 'alpha',
				key: 'existing',
				valueJson: 'null',
				valueJsonVersion: 1,
				storedBytes: PLUGIN_STORAGE_LIMITS.maxTotalBytes - targetBytes,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('pluginStorageUsage', {
				organizationId: 'tenant',
				pluginId: 'alpha',
				entryCount: 1,
				totalStoredBytes: PLUGIN_STORAGE_LIMITS.maxTotalBytes - targetBytes,
				updatedAt: now,
			});

			await service.set(key, value);
			expect((await ctx.db.query('pluginStorageUsage').unique())?.totalStoredBytes).toBe(
				PLUGIN_STORAGE_LIMITS.maxTotalBytes
			);
			await expect(service.set(key, `${value}x`)).rejects.toMatchObject({
				code: 'quota_exceeded',
			});
			expect(await service.get(key)).toBe(value);
		});
	});

	it('allows the exact entry-count quota and rejects one more without a partial write', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant', 'alpha');
			const now = Date.now();
			await ctx.db.insert('pluginStorageEntries', {
				organizationId: 'tenant',
				pluginId: 'alpha',
				key: 'existing',
				valueJson: 'null',
				valueJsonVersion: 1,
				storedBytes: 12,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('pluginStorageUsage', {
				organizationId: 'tenant',
				pluginId: 'alpha',
				entryCount: PLUGIN_STORAGE_LIMITS.maxEntries - 1,
				totalStoredBytes: 12,
				updatedAt: now,
			});

			await service.set('at-limit', true);
			expect((await ctx.db.query('pluginStorageUsage').unique())?.entryCount).toBe(
				PLUGIN_STORAGE_LIMITS.maxEntries
			);
			await expect(service.set('over-limit', true)).rejects.toMatchObject({
				code: 'quota_exceeded',
			});
			expect(await service.get('over-limit')).toBeUndefined();
		});
	});

	it.each([
		['zero entry count', 0, 100],
		['stored-byte undercount', 1, 1],
		['single-entry stored-byte overcount', 1, 13],
		['additional entry without additional bytes', 2, 12],
	] as const)('fails closed on corrupt usage: %s', async (_label, entryCount, totalStoredBytes) => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant', 'alpha');
			const now = Date.now();
			await ctx.db.insert('pluginStorageEntries', {
				organizationId: 'tenant',
				pluginId: 'alpha',
				key: 'existing',
				valueJson: 'true',
				valueJsonVersion: 1,
				storedBytes: 12,
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('pluginStorageUsage', {
				organizationId: 'tenant',
				pluginId: 'alpha',
				entryCount,
				totalStoredBytes,
				updatedAt: now,
			});

			await expect(service.set('existing', false)).rejects.toMatchObject({
				code: 'storage_unavailable',
			});
			expect(await service.get('existing')).toBe(true);
			expect((await ctx.db.query('pluginStorageUsage').unique())?.entryCount).toBe(entryCount);
		});
	});

	it('serializes concurrent quota-counter updates transactionally', async () => {
		const t = convexTest(schema, modules);
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				t.run(async (ctx) => (await storage(ctx, 'tenant', 'alpha')).set(`key-${index}`, index))
			)
		);

		await t.run(async (ctx) => {
			const usage = await ctx.db.query('pluginStorageUsage').unique();
			const entries = await ctx.db.query('pluginStorageEntries').take(21);
			expect(usage?.entryCount).toBe(20);
			expect(usage?.totalStoredBytes).toBe(
				entries.reduce((total, entry) => total + entry.storedBytes, 0)
			);
		});
	});

	it('binds encrypted cursors to tenant, plugin, prefix, and page shape', async () => {
		const t = convexTest(schema, modules);
		let cursor: string | undefined;
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant-a', 'alpha');
			await service.set('mail:a', 1);
			await service.set('mail:b', 2);
			await service.set('other:c', 3);
			const first = await service.list({ prefix: 'mail:', limit: 1 });
			expect(first.keys).toEqual(['mail:a']);
			cursor = first.cursor;
			expect(cursor).toBeTypeOf('string');
		});

		await t.run(async (ctx) => {
			expect(
				await (await storage(ctx, 'tenant-a', 'alpha')).list({ prefix: 'mail:', limit: 1, cursor })
			).toMatchObject({ keys: ['mail:b'] });
			for (const serviceAndOptions of [
				[await storage(ctx, 'tenant-b', 'alpha'), { prefix: 'mail:', limit: 1, cursor }],
				[await storage(ctx, 'tenant-a', 'beta'), { prefix: 'mail:', limit: 1, cursor }],
				[await storage(ctx, 'tenant-a', 'alpha'), { prefix: 'other:', limit: 1, cursor }],
				[await storage(ctx, 'tenant-a', 'alpha'), { prefix: 'mail:', limit: 2, cursor }],
			] as const) {
				await expect(serviceAndOptions[0].list(serviceAndOptions[1])).rejects.toMatchObject({
					code: 'invalid_input',
				});
			}
		});
	});

	it('classifies pagination runtime failures separately from malformed client cursors', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'tenant', 'alpha');
			await service.set('a', 1);
			await service.set('b', 2);
			await service.list({ limit: 1 });
			await expect(service.list({ limit: 1 })).rejects.toMatchObject({
				code: 'storage_unavailable',
			});
			await expect(service.list({ cursor: 'malformed-client-token' })).rejects.toMatchObject({
				code: 'invalid_input',
			});
		});
	});

	it('rejects malformed key, value, list options, and cursor without leaking inputs', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const service = await storage(ctx, 'sensitive-tenant', 'sensitive-plugin');
			const hostileKey = 'secret-key';
			const calls = [
				service.get(''),
				service.set(hostileKey, Number.NaN as never),
				service.list({ limit: 0 }),
				service.list({ cursor: 'secret-cursor' }),
			];
			for (const call of calls) {
				const error = (await call.catch((cause) => cause)) as PluginStorageError;
				expect(error).toBeInstanceOf(PluginStorageError);
				expect(error.message).not.toContain('sensitive');
				expect(error.message).not.toContain('secret');
			}

			let getterReads = 0;
			const options = Object.defineProperty({}, 'prefix', {
				enumerable: true,
				get() {
					getterReads += 1;
					return 'secret';
				},
			});
			await expect(service.list(options)).rejects.toMatchObject({ code: 'invalid_input' });
			expect(getterReads).toBe(0);
		});
	});
});
