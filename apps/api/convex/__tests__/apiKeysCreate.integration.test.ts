import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

/**
 * apiKeys.create is least-privilege by construction: it requires an explicit,
 * non-empty, valid scope list and stores exactly those scopes — no silent
 * all-scopes default. (See finding #12 in the data-isolation review.)
 */
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

describe('apiKeys.create — least privilege', () => {
	it('rejects creation with no scopes (no silent all-scopes default)', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await expect(t.mutation(api.auth.apiKeys.create, { name: 'no-scopes' })).rejects.toThrow(
			/At least one API scope is required/
		);
	});

	it('rejects an empty scopes array', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await expect(
			t.mutation(api.auth.apiKeys.create, { name: 'empty', scopes: [] })
		).rejects.toThrow(/At least one API scope is required/);
	});

	it('rejects unknown scopes', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await expect(
			t.mutation(api.auth.apiKeys.create, { name: 'typo', scopes: ['contacts:reed'] })
		).rejects.toThrow(/Unknown API scope/);
	});

	it('rejects a Tier-2-only scope on a standalone (unbound) key', async () => {
		// mail:read (and the rest of the Tier-2-only vocabulary) is reachable ONLY
		// through a plugin-bound key. Minting a standalone key that carries it must
		// fail closed so the plugin-binding + operator-grant boundary cannot be
		// bypassed by an unbound key.
		const t = convexTest(schema, modules).withIdentity(testUser);
		await expect(
			t.mutation(api.auth.apiKeys.create, { name: 'tier2', scopes: ['mail:read'] })
		).rejects.toThrow(/only available on plugin-bound keys/);
	});

	it('lists every offending Tier-2-only scope when several are requested', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await expect(
			t.mutation(api.auth.apiKeys.create, {
				name: 'tier2-mix',
				scopes: ['contacts:read', 'webhooks:manage', 'plugin-storage:write'],
			})
		).rejects.toThrow(/webhooks:manage, plugin-storage:write/);
	});

	it('still accepts the endpoint-backed scopes on a standalone key', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const result = await t.mutation(api.auth.apiKeys.create, {
			name: 'endpoint',
			scopes: ['contacts:read', 'events:write'],
		});
		const stored = await t.run(async (ctx) => ctx.db.get(result.keyId));
		expect(stored?.scopes).toEqual(['contacts:read', 'events:write']);
	});

	it('stores exactly the requested scopes', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const result = await t.mutation(api.auth.apiKeys.create, {
			name: 'scoped',
			scopes: ['contacts:read', 'transactional:send'],
		});
		const stored = await t.run(async (ctx) => ctx.db.get(result.keyId));
		expect(stored?.scopes).toEqual(['contacts:read', 'transactional:send']);
	});

	it('de-duplicates repeated scopes', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const result = await t.mutation(api.auth.apiKeys.create, {
			name: 'dupes',
			scopes: ['contacts:read', 'contacts:read', 'events:write'],
		});
		const stored = await t.run(async (ctx) => ctx.db.get(result.keyId));
		expect(stored?.scopes).toEqual(['contacts:read', 'events:write']);
	});

	it('rejects an expiry that is not in the future', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		await expect(
			t.mutation(api.auth.apiKeys.create, {
				name: 'past-expiry',
				scopes: ['contacts:read'],
				expiresAt: Date.now() - 1000,
			})
		).rejects.toThrow(/expiry must be in the future/i);
	});

	it('stores a future expiry on the key', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const expiresAt = Date.now() + 60_000;
		const result = await t.mutation(api.auth.apiKeys.create, {
			name: 'expiring',
			scopes: ['contacts:read'],
			expiresAt,
		});
		const stored = await t.run(async (ctx) => ctx.db.get(result.keyId));
		expect(stored?.expiresAt).toBe(expiresAt);
	});
});

/**
 * L2 — `listByTeam` must not return the stored `keyHash` (the SHA-256 verifier).
 * A management list has no use for it, and returning it hands an admin-scoped
 * reader an offline brute-force target.
 */
describe('apiKeys.listByTeam — keyHash projection', () => {
	it('omits keyHash from every listed key but keeps the display prefix', async () => {
		const t = convexTest(schema, modules).withIdentity(testUser);
		const created = await t.mutation(api.auth.apiKeys.create, {
			name: 'listed',
			scopes: ['contacts:read'],
		});

		const listed = await t.query(api.auth.apiKeys.listByTeam, {});
		expect(listed.length).toBe(1);
		const row = listed[0]!;
		expect('keyHash' in row).toBe(false);
		// The prefix (safe display identifier) and name still surface for the UI.
		expect(row.keyPrefix).toBe(created.keyPrefix);
		expect(row.name).toBe('listed');
		expect(row._id).toBe(created.keyId);
	});
});
