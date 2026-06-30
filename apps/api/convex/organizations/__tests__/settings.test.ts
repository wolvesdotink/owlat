import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { OrganizationRole } from '../../lib/sessionOrganization';

/**
 * Unit tests for the Organization settings (module).
 *
 * Covers the four entry points (`get`, `update`, `remove`, `createInternal`)
 * and the permission-unification regression for `update`: any-org-member
 * writes are refused with the `settings:manage` error, owner/admin writes
 * succeed.
 *
 * See docs/adr/0026-organization-settings-modules.md.
 */

let mockRole: OrganizationRole = 'owner';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/sessionOrganization')
	>('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ({
			userId: 'test-user',
			role: mockRole,
		})),
	};
});

// Vite canonicalizes glob keys for files in this same subtree: a sibling
// at convex/organizations/X is keyed as '../X' rather than '../../organizations/X'.
// convex-test computes its lookup prefix from '../../_generated/...', so the
// canonicalized keys would never match. Re-prefix the canonicalized half.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../organizations/' + key.slice(3), val];
		}
		return [key, val];
	}),
);

beforeEach(() => {
	mockRole = 'owner';
});

// ============================================================
// get — read the singleton row
// ============================================================

describe('organizations.settings.get', () => {
	it('returns null when no settings row exists', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.organizations.settings.get, {});
		expect(result).toBeNull();
	});

	it('returns the singleton row when present', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				timezone: 'America/New_York',
				defaultFromName: 'Acme',
				createdAt: Date.now(),
			});
		});

		const result = await t.query(api.organizations.settings.get, {});
		expect(result).not.toBeNull();
		expect(result?.timezone).toBe('America/New_York');
		expect(result?.defaultFromName).toBe('Acme');
	});
});

// ============================================================
// update — permission unification regression
// ============================================================

describe('organizations.settings.update — permission rule', () => {
	it('rejects editor role with settings:manage error', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'editor';
		await expect(
			t.mutation(api.organizations.settings.update, {
				timezone: 'UTC',
			}),
		).rejects.toThrow(/owners and admins/);
	});

	it('allows admin role', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'admin';
		await t.mutation(api.organizations.settings.update, {
			timezone: 'Europe/Berlin',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.timezone).toBe('Europe/Berlin');
		});
	});

	it('allows owner role', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'owner';
		await t.mutation(api.organizations.settings.update, {
			defaultFromName: 'Wolves',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.defaultFromName).toBe('Wolves');
		});
	});
});

// ============================================================
// update — write semantics
// ============================================================

describe('organizations.settings.update — write semantics', () => {
	it('creates the singleton row on first write', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.settings.update, {
			timezone: 'UTC',
			defaultFromName: 'first',
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('instanceSettings').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.timezone).toBe('UTC');
			expect(rows[0]!.defaultFromName).toBe('first');
			expect(rows[0]!.createdAt).toBeGreaterThan(0);
			expect(rows[0]!.updatedAt).toBeGreaterThan(0);
		});
	});

	it('patches the existing row on subsequent writes', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.settings.update, {
			timezone: 'UTC',
			defaultFromName: 'one',
		});
		await t.mutation(api.organizations.settings.update, {
			defaultFromName: 'two',
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('instanceSettings').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.defaultFromName).toBe('two');
			// timezone is preserved by the patch (only provided fields overwrite).
			expect(rows[0]!.timezone).toBe('UTC');
		});
	});

	it('persists emailTheme', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.organizations.settings.update, {
			emailTheme: {
				primaryColor: '#ff0000',
				fontFamily: 'Arial, sans-serif',
				backgroundColor: '#ffffff',
				baseWidth: 700,
			},
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.emailTheme?.primaryColor).toBe('#ff0000');
			expect(row?.emailTheme?.baseWidth).toBe(700);
		});
	});
});

// ============================================================
// remove — owner-only, schedules walker
// ============================================================

describe('organizations.settings.remove', () => {
	it('rejects non-owner roles', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'admin';
		await expect(
			t.mutation(api.organizations.settings.remove, {}),
		).rejects.toThrow(/owner/);

		mockRole = 'editor';
		await expect(
			t.mutation(api.organizations.settings.remove, {}),
		).rejects.toThrow(/owner/);
	});

	it('returns success message and schedules the deletion walker for owner', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'owner';
		const outcome = await t.mutation(
			api.organizations.settings.remove,
			{},
		);
		expect(outcome.success).toBe(true);
		expect(outcome.message).toContain('deletion');

		// Drain anything the scheduler kicked off so the test isolate cleans up.
		await t.finishInProgressScheduledFunctions();
	});
});

// ============================================================
// createInternal — idempotent bootstrap
// ============================================================

describe('organizations.settings.createInternal', () => {
	it('inserts the row when none exists', async () => {
		const t = convexTest(schema, modules);

		const id = await t.mutation(
			internal.organizations.settings.createInternal,
			{
				timezone: 'UTC',
				defaultFromName: 'Bootstrap',
			},
		);

		expect(id).toBeDefined();
		await t.run(async (ctx) => {
			const row = await ctx.db.get(id);
			expect(row?.timezone).toBe('UTC');
			expect(row?.defaultFromName).toBe('Bootstrap');
		});
	});

	it('returns the existing row id when one already exists (idempotent)', async () => {
		const t = convexTest(schema, modules);

		let existingId: string;
		await t.run(async (ctx) => {
			existingId = await ctx.db.insert('instanceSettings', {
				timezone: 'Europe/Berlin',
				createdAt: Date.now(),
			});
		});

		const id = await t.mutation(
			internal.organizations.settings.createInternal,
			{
				timezone: 'UTC',
				defaultFromName: 'second',
			},
		);

		expect(id).toBe(existingId!);
		await t.run(async (ctx) => {
			// Existing row untouched.
			const row = await ctx.db.get(id);
			expect(row?.timezone).toBe('Europe/Berlin');
		});
	});

	it('defaults timezone to UTC when omitted', async () => {
		const t = convexTest(schema, modules);

		const id = await t.mutation(
			internal.organizations.settings.createInternal,
			{},
		);

		await t.run(async (ctx) => {
			const row = await ctx.db.get(id);
			expect(row?.timezone).toBe('UTC');
		});
	});
});
