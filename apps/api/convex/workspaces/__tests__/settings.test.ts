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
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ({
			userId: 'test-user',
			role: mockRole,
		})),
		// settings.update now gates via requireOrgPermission; run the real
		// role→permission map against the mocked role so the editor rejection
		// and owner/admin acceptance gates are exercised end-to-end.
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				const mod: typeof import('../../lib/sessionOrganization') = actual;
				mod.requirePermission(
					mod.hasPermission(
						mockRole as Parameters<typeof mod.hasPermission>[0],
						permission as Parameters<typeof mod.hasPermission>[1]
					),
					message
				);
				return { userId: 'test-user', role: mockRole };
			}),
	};
});

// Vite canonicalizes glob keys for files in this same subtree: a sibling
// at convex/workspaces/X is keyed as '../X' rather than '../../workspaces/X'.
// convex-test computes its lookup prefix from '../../_generated/...', so the
// canonicalized keys would never match. Re-prefix the canonicalized half.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../workspaces/' + key.slice(3), val];
		}
		return [key, val];
	})
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
		const result = await t.query(api.workspaces.settings.get, {});
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

		const result = await t.query(api.workspaces.settings.get, {});
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
			t.mutation(api.workspaces.settings.update, {
				timezone: 'UTC',
			})
		).rejects.toThrow(/owners and admins/);
	});

	it('allows admin role', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'admin';
		await t.mutation(api.workspaces.settings.update, {
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
		await t.mutation(api.workspaces.settings.update, {
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
	it('audits security-sensitive delivery setting changes', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.workspaces.settings.update, {
			mtaStsMode: 'enforce',
			trustedArcForwarders: ['lists.example.org'],
			sealPolicy: 'ask',
			isInboundTlsRequired: false,
		});

		await t.run(async (ctx) => {
			const audit = await ctx.db.query('auditLogs').first();
			expect(audit?.userId).toBe('test-user');
			expect(audit?.action).toBe('settings.updated');
			expect(audit?.resource).toBe('settings');
			const details = JSON.parse(audit?.detailsBlob ?? '{}') as {
				changes?: Record<string, { from: unknown; to: unknown }>;
			};
			expect(details.changes?.['mtaStsMode']).toEqual({ from: null, to: 'enforce' });
			expect(details.changes?.['trustedArcForwarders']).toEqual({
				from: null,
				to: ['lists.example.org'],
			});
			expect(details.changes?.['sealPolicy']).toEqual({ from: null, to: 'ask' });
			expect(details.changes?.['isInboundTlsRequired']).toEqual({ from: null, to: false });
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.some((job) => job.name.includes('pushInboundTlsPolicy'))).toBe(true);
		});
	});

	it('rejects oversized trusted ARC forwarder lists', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.workspaces.settings.update, {
				trustedArcForwarders: Array.from({ length: 101 }, (_, index) => `list-${index}.example`),
			})
		).rejects.toThrow(/At most 100/);
	});

	it('creates the singleton row on first write', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(api.workspaces.settings.update, {
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

		await t.mutation(api.workspaces.settings.update, {
			timezone: 'UTC',
			defaultFromName: 'one',
		});
		await t.mutation(api.workspaces.settings.update, {
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

		await t.mutation(api.workspaces.settings.update, {
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
// isMigrationMode — instance-level "moving from another platform" flag
// ============================================================

describe('organizations.settings — isMigrationMode', () => {
	it('is absent by default (fresh-start) when no row exists', async () => {
		const t = convexTest(schema, modules);
		const result = await t.query(api.workspaces.settings.get, {});
		expect(result).toBeNull();
	});

	it('is member-readable via get (the welcome flow reads it)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				isMigrationMode: true,
				createdAt: Date.now(),
			});
		});

		// getUserIdFromSession is mocked to a plain member — no admin gate on read.
		const result = await t.query(api.workspaces.settings.get, {});
		expect(result?.isMigrationMode).toBe(true);
	});

	it('rejects an editor writing isMigrationMode', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'editor';
		await expect(
			t.mutation(api.workspaces.settings.update, {
				isMigrationMode: true,
			})
		).rejects.toThrow(/owners and admins/);
	});

	it('lets an admin turn isMigrationMode on', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'admin';
		await t.mutation(api.workspaces.settings.update, {
			isMigrationMode: true,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			expect(row?.isMigrationMode).toBe(true);
		});
	});

	it('createInternal defaults isMigrationMode to false', async () => {
		const t = convexTest(schema, modules);

		const id = await t.mutation(internal.workspaces.settings.createInternal, {
			timezone: 'UTC',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(id);
			expect(row?.isMigrationMode).toBe(false);
		});
	});

	it('createInternal persists isMigrationMode when the wizard seeds it', async () => {
		const t = convexTest(schema, modules);

		const id = await t.mutation(internal.workspaces.settings.createInternal, {
			timezone: 'UTC',
			isMigrationMode: true,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(id);
			expect(row?.isMigrationMode).toBe(true);
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
		await expect(t.mutation(api.workspaces.settings.remove, {})).rejects.toThrow(/owner/);

		mockRole = 'editor';
		await expect(t.mutation(api.workspaces.settings.remove, {})).rejects.toThrow(/owner/);
	});

	it('returns success message and schedules the deletion walker for owner', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'owner';
		const outcome = await t.mutation(api.workspaces.settings.remove, {});
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

		const id = await t.mutation(internal.workspaces.settings.createInternal, {
			timezone: 'UTC',
			defaultFromName: 'Bootstrap',
		});

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

		const id = await t.mutation(internal.workspaces.settings.createInternal, {
			timezone: 'UTC',
			defaultFromName: 'second',
		});

		expect(id).toBe(existingId!);
		await t.run(async (ctx) => {
			// Existing row untouched.
			const row = await ctx.db.get(id);
			expect(row?.timezone).toBe('Europe/Berlin');
		});
	});

	it('defaults timezone to UTC when omitted', async () => {
		const t = convexTest(schema, modules);

		const id = await t.mutation(internal.workspaces.settings.createInternal, {});

		await t.run(async (ctx) => {
			const row = await ctx.db.get(id);
			expect(row?.timezone).toBe('UTC');
		});
	});
});
