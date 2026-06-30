import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';

/**
 * Read-path coverage for the audit-log operator surface
 * (auditLogs.list / get / getStats / getActiveUsers). The write path (the
 * recordAuditLog chokepoint) is exercised across ~22 integration suites, but
 * these four permission-gated queries — ordering, filtering, cursor pagination,
 * the userProfile join, and the organization:manage gate — had no direct test.
 */

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('admin-1'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

const BASE = 1_700_000_000_000;

/** Seed audit rows + a userProfile for the actor. Returns the actor id. */
async function seed(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: 'admin-1',
			email: 'admin@example.com',
			name: 'Admin One',
			createdAt: BASE,
			updatedAt: BASE,
		});
		// Three rows, ascending createdAt; mixed action/resource.
		await ctx.db.insert('auditLogs', {
			userId: 'admin-1',
			action: 'campaign.created',
			resource: 'campaign',
			createdAt: BASE + 1000,
		});
		await ctx.db.insert('auditLogs', {
			userId: 'admin-1',
			action: 'campaign.sent',
			resource: 'campaign',
			createdAt: BASE + 2000,
		});
		await ctx.db.insert('auditLogs', {
			userId: 'other-user',
			action: 'settings.updated',
			resource: 'settings',
			createdAt: BASE + 3000,
		});
	});
}

describe('auditLogs.list', () => {
	it('returns rows newest-first and joins the actor profile', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		const res = await t.query(api.auditLogs.list, {});
		expect(res.logs).toHaveLength(3);
		expect(res.logs[0]!.action).toBe('settings.updated'); // newest
		expect(res.logs[2]!.action).toBe('campaign.created'); // oldest
		const adminRow = res.logs.find((l) => l.userId === 'admin-1');
		expect(adminRow!.userProfile?.name).toBe('Admin One');
		// A row whose actor has no profile joins to null, not a throw.
		const otherRow = res.logs.find((l) => l.userId === 'other-user');
		expect(otherRow!.userProfile).toBeNull();
	});

	it('filters by action, resource, and userId', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		expect((await t.query(api.auditLogs.list, { action: 'campaign.sent' })).logs).toHaveLength(1);
		expect((await t.query(api.auditLogs.list, { resource: 'settings' })).logs).toHaveLength(1);
		expect((await t.query(api.auditLogs.list, { userId: 'admin-1' })).logs).toHaveLength(2);
	});

	it('filters by date range', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		const res = await t.query(api.auditLogs.list, {
			startDate: BASE + 1500,
			endDate: BASE + 2500,
		});
		expect(res.logs).toHaveLength(1);
		expect(res.logs[0]!.action).toBe('campaign.sent');
	});

	it('paginates via an opaque cursor', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		const first = await t.query(api.auditLogs.list, { limit: 2 });
		expect(first.logs).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBeTruthy();

		const second = await t.query(api.auditLogs.list, { limit: 2, cursor: first.nextCursor! });
		expect(second.logs).toHaveLength(1);
		expect(second.hasMore).toBe(false);
		expect(second.nextCursor).toBeNull();
	});

	it('rejects a caller without organization:manage', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		vi.mocked(requireOrgPermission).mockRejectedValueOnce(new Error('forbidden'));
		await expect(t.query(api.auditLogs.list, {})).rejects.toThrow('forbidden');
	});
});

describe('auditLogs.get', () => {
	it('returns the row with its actor profile', async () => {
		const t = convexTest(schema, modules);
		await seed(t);
		const id = await t.run(async (ctx) => {
			const row = await ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'campaign.sent'))
				.first();
			return row!._id;
		});

		const res = await t.query(api.auditLogs.get, { auditLogId: id });
		expect(res!.action).toBe('campaign.sent');
		expect(res!.userProfile?.email).toBe('admin@example.com');
	});

	it('returns null for a deleted/missing row', async () => {
		const t = convexTest(schema, modules);
		const id = await t.run(async (ctx) => {
			const rowId = await ctx.db.insert('auditLogs', {
				userId: 'admin-1',
				action: 'campaign.created',
				resource: 'campaign',
				createdAt: BASE,
			});
			await ctx.db.delete(rowId);
			return rowId;
		});
		expect(await t.query(api.auditLogs.get, { auditLogId: id })).toBeNull();
	});
});

describe('auditLogs.getStats', () => {
	it('totals counts by action and resource within the range', async () => {
		const t = convexTest(schema, modules);
		await seed(t);

		const stats = await t.query(api.auditLogs.getStats, {
			startDate: BASE,
			endDate: BASE + 10_000,
		});
		expect(stats.total).toBe(3);
		expect(stats.byResource).toEqual({ campaign: 2, settings: 1 });
		expect(stats.byAction['campaign.created']).toBe(1);
		expect(stats.byAction['campaign.sent']).toBe(1);
		expect(stats.byAction['settings.updated']).toBe(1);
	});
});

describe('auditLogs.getActiveUsers', () => {
	it('returns distinct actors that have a profile, paired with authUserId', async () => {
		const t = convexTest(schema, modules);
		// Seed recent rows so they fall inside the 90-day window.
		await t.run(async (ctx) => {
			await ctx.db.insert('userProfiles', {
				authUserId: 'admin-1',
				email: 'admin@example.com',
				name: 'Admin One',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('auditLogs', {
				userId: 'admin-1',
				action: 'campaign.created',
				resource: 'campaign',
				createdAt: Date.now(),
			});
			await ctx.db.insert('auditLogs', {
				userId: 'admin-1',
				action: 'campaign.sent',
				resource: 'campaign',
				createdAt: Date.now(),
			});
			// Actor without a profile — excluded from the dropdown list.
			await ctx.db.insert('auditLogs', {
				userId: 'ghost-user',
				action: 'settings.updated',
				resource: 'settings',
				createdAt: Date.now(),
			});
		});

		const users = await t.query(api.auditLogs.getActiveUsers, {});
		expect(users).toHaveLength(1);
		expect(users[0]!.authUserId).toBe('admin-1');
		expect(users[0]!.email).toBe('admin@example.com');
	});
});
