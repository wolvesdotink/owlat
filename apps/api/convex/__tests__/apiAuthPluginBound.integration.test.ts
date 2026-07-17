import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { createTestContact } from './factories';

/**
 * PP-21 end-to-end: a plugin-bound API key is enforced through the real
 * `/api/v1/*` routing + `createAuthenticatedHandler` auth wrapper, exactly like
 * v1RestApi.integration.test.ts. It proves the Tier-2 revocation contract on
 * the actual scoped surface:
 *
 *   - a bound key works only while the plugin is enabled AND the scope granted;
 *   - disabling the plugin fails the SAME key closed on the next request;
 *   - revoking the operator grant fails it closed;
 *   - a key bound to an uninstalled plugin is closed from the start;
 *   - one-click revokeByPlugin turns the key off outright (401).
 *
 * A mock composition supplies the installed plugin (convex-test honours the
 * module mock, so the enforcement mutation resolves the mocked manifest/flag).
 */
vi.mock('../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/connector',
			manifest: Object.freeze({
				id: 'acme-connector',
				version: '1.0.0',
				capabilities: Object.freeze(['contacts:read']),
				flag: Object.freeze({ default: false }),
			}),
		}),
	]),
}));

// The org-permission gate on revokeByPlugin is mocked open so the mutation can
// run without a full session; enforcement (the code under test) is untouched.
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
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('semanticFileProcessing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

const testUser = { subject: 'admin-user', issuer: 'test', tokenIdentifier: 'test|admin-user' };

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function hashKey(k: string): Promise<string> {
	const d = new TextEncoder().encode(k);
	const h = await crypto.subtle.digest('SHA-256', d);
	return Array.from(new Uint8Array(h))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function makeKey(suffix = 'a'.repeat(40)): string {
	return 'lm_live_' + suffix;
}

function authHeaders(key: string): Record<string, string> {
	return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function seedSettings(
	t: ReturnType<typeof convexTest>,
	featureFlags: Record<string, boolean>,
	grants: Record<string, Record<string, boolean>>
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags,
			pluginCapabilityGrants: grants,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedBoundKey(
	t: ReturnType<typeof convexTest>,
	opts: { pluginId?: string; scopes: string[]; suffix?: string }
): Promise<string> {
	const key = makeKey(opts.suffix);
	const keyHash = await hashKey(key);
	await t.run(async (ctx) => {
		await ctx.db.insert('apiKeys', {
			name: 'bound-key',
			keyHash,
			keyPrefix: 'lm_live_',
			isActive: true,
			scopes: opts.scopes,
			...(opts.pluginId !== undefined ? { pluginId: opts.pluginId } : {}),
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
	return key;
}

async function seedOneContact(t: ReturnType<typeof convexTest>) {
	await t.run(async (ctx) => {
		await ctx.db.insert('contacts', createTestContact({ email: 'bound@example.com' }));
	});
}

const SAVED_ENV = { ...process.env };
beforeEach(() => {
	delete process.env['SITE_URL'];
});
afterEach(() => {
	process.env = { ...SAVED_ENV };
});

describe('plugin-bound key enforcement on /api/v1/contacts', () => {
	it('200 while the plugin is enabled and the scope is granted', async () => {
		const t = setupTest();
		await seedSettings(
			t,
			{ 'plugin.acme-connector': true },
			{ 'plugin.acme-connector': { 'contacts:read': true } }
		);
		await seedOneContact(t);
		const key = await seedBoundKey(t, { pluginId: 'acme-connector', scopes: ['contacts:read'] });
		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(200);
	});

	it('403 for the SAME key the instant its plugin is disabled (immediate revocation)', async () => {
		const t = setupTest();
		await seedSettings(
			t,
			{ 'plugin.acme-connector': true },
			{ 'plugin.acme-connector': { 'contacts:read': true } }
		);
		await seedOneContact(t);
		const key = await seedBoundKey(t, { pluginId: 'acme-connector', scopes: ['contacts:read'] });

		expect(
			(await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) })).status
		).toBe(200);

		// Operator disables the plugin — no touch to the key row.
		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(s!._id, { featureFlags: { 'plugin.acme-connector': false } });
		});

		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(403);
	});

	it('403 the instant the operator revokes the grant', async () => {
		const t = setupTest();
		await seedSettings(
			t,
			{ 'plugin.acme-connector': true },
			{ 'plugin.acme-connector': { 'contacts:read': true } }
		);
		await seedOneContact(t);
		const key = await seedBoundKey(t, { pluginId: 'acme-connector', scopes: ['contacts:read'] });

		await t.run(async (ctx) => {
			const s = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(s!._id, { pluginCapabilityGrants: { 'plugin.acme-connector': {} } });
		});

		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(403);
	});

	it('403 for a key bound to an uninstalled plugin, even with the scope stored', async () => {
		const t = setupTest();
		await seedSettings(t, {}, {});
		await seedOneContact(t);
		const key = await seedBoundKey(t, { pluginId: 'ghost-plugin', scopes: ['contacts:read'] });
		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(403);
	});

	it('401 after one-click revokeByPlugin turns the key inactive', async () => {
		const t = setupTest();
		await seedSettings(
			t,
			{ 'plugin.acme-connector': true },
			{ 'plugin.acme-connector': { 'contacts:read': true } }
		);
		await seedOneContact(t);
		const key = await seedBoundKey(t, { pluginId: 'acme-connector', scopes: ['contacts:read'] });

		expect(
			(await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) })).status
		).toBe(200);

		await t
			.withIdentity(testUser)
			.mutation(api.auth.apiKeys.revokeByPlugin, { pluginId: 'acme-connector' });

		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(401);
	});

	it('a standalone key is unaffected by plugin state (migration safety)', async () => {
		const t = setupTest();
		await seedSettings(t, {}, {});
		await seedOneContact(t);
		const key = await seedBoundKey(t, { scopes: ['contacts:read'] });
		const res = await t.fetch('/api/v1/contacts', { method: 'GET', headers: authHeaders(key) });
		expect(res.status).toBe(200);
	});
});
