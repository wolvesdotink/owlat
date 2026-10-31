import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

/**
 * The inverses of the two onboarding dismissals: `onboarding.restore` (the
 * instance-wide surface, admin + self) and `userOnboarding.restore` (the
 * caller's own checklist, self). Both double as Undo when handed the
 * `dismissedAt` token their `dismiss` returned, and must then leave a later
 * dismissal in place.
 */

const sessionMocks = vi.hoisted(() => ({
	userId: 'admin-a',
	role: 'admin' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		requireSelf: vi.fn(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMocks.userId) throw new Error('forbidden: not self');
			return claimed;
		}),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ([`../../auth/${key.slice(3)}`, val] as const)
			: ([key, val] as const)
	)
);

const T0 = Date.parse('2026-08-01T09:00:00Z');

beforeEach(() => {
	sessionMocks.userId = 'admin-a';
	sessionMocks.role = 'admin';
});

async function seedDismissal(
	t: ReturnType<typeof convexTest>,
	userId: string,
	dismissedAt: number
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('onboardingProgress', {
			userId,
			dismissed: true,
			dismissedAt,
			createdAt: dismissedAt,
			updatedAt: dismissedAt,
		});
	});
}

async function dismissedUsers(t: ReturnType<typeof convexTest>): Promise<string[]> {
	const rows = await t.run(async (ctx) => ctx.db.query('onboardingProgress').collect());
	return rows
		.filter((row) => row.dismissed)
		.map((row) => row.userId)
		.sort();
}

describe('onboarding.restore — instance surface', () => {
	it('round-trips a dismissal and returns the Undo token', async () => {
		const t = convexTest(schema, modules);

		const dismissed = await t.mutation(api.auth.onboarding.dismiss, { userId: 'admin-a' });
		expect(dismissed.dismissedAt).toEqual(expect.any(Number));

		const restored = await t.mutation(api.auth.onboarding.restore, {
			userId: 'admin-a',
			dismissedAt: dismissed.dismissedAt,
		});
		expect(restored).toEqual({ isDismissed: false });

		const progress = await t.query(api.auth.onboarding.getWithActualProgress, {
			userId: 'admin-a',
		});
		expect(progress.dismissed).toBe(false);
		expect(progress.dismissedAt).toBeUndefined();
	});

	it("clears every admin's dismissal, since any one of them hides the surface", async () => {
		const t = convexTest(schema, modules);
		await seedDismissal(t, 'admin-a', T0);
		await seedDismissal(t, 'admin-b', T0 - 1000);
		await seedDismissal(t, 'admin-c', T0 - 2000);

		const restored = await t.mutation(api.auth.onboarding.restore, { userId: 'admin-a' });

		expect(restored).toEqual({ isDismissed: false });
		expect(await dismissedUsers(t)).toEqual([]);
	});

	it('as Undo, leaves a dismissal made after the token in place', async () => {
		const t = convexTest(schema, modules);
		await seedDismissal(t, 'admin-a', T0);
		await seedDismissal(t, 'admin-b', T0 + 5000);

		const restored = await t.mutation(api.auth.onboarding.restore, {
			userId: 'admin-a',
			dismissedAt: T0,
		});

		expect(restored).toEqual({ isDismissed: true });
		expect(await dismissedUsers(t)).toEqual(['admin-b']);
	});

	it('is idempotent and answers "not dismissed" when nothing is', async () => {
		const t = convexTest(schema, modules);

		expect(await t.mutation(api.auth.onboarding.restore, { userId: 'admin-a' })).toEqual({
			isDismissed: false,
		});
		expect(await t.mutation(api.auth.onboarding.restore, { userId: 'admin-a' })).toEqual({
			isDismissed: false,
		});
		const rows = await t.run(async (ctx) => ctx.db.query('onboardingProgress').collect());
		expect(rows).toHaveLength(0);
	});

	it('rejects an ordinary member and leaves the dismissal standing', async () => {
		const t = convexTest(schema, modules);
		await seedDismissal(t, 'admin-b', T0);
		sessionMocks.userId = 'member-a';
		sessionMocks.role = 'editor';

		await expect(t.mutation(api.auth.onboarding.restore, { userId: 'member-a' })).rejects.toThrow();
		expect(await dismissedUsers(t)).toEqual(['admin-b']);
	});

	it('binds the caller to userId (self)', async () => {
		const t = convexTest(schema, modules);
		await seedDismissal(t, 'admin-b', T0);

		await expect(t.mutation(api.auth.onboarding.restore, { userId: 'admin-b' })).rejects.toThrow(
			/not self/
		);
		expect(await dismissedUsers(t)).toEqual(['admin-b']);
	});
});

describe('userOnboarding.restore — the caller’s own checklist', () => {
	it('round-trips a dismissal and keeps step and welcome stamps', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.userId = 'member-a';
		sessionMocks.role = 'editor';
		await t.run(async (ctx) => {
			await ctx.db.insert('userOnboarding', {
				authUserId: 'member-a',
				mailboxReady: T0 - 5000,
				welcomedAt: T0 - 6000,
				createdAt: T0 - 6000,
				updatedAt: T0 - 5000,
			});
		});

		const dismissed = await t.mutation(api.auth.userOnboarding.dismiss, { userId: 'member-a' });
		const restored = await t.mutation(api.auth.userOnboarding.restore, {
			userId: 'member-a',
			dismissedAt: dismissed.dismissedAt,
		});
		expect(restored).toEqual({ isDismissed: false });

		const state = await t.query(api.auth.userOnboarding.get, { userId: 'member-a' });
		expect(state.dismissedAt).toBeNull();
		expect(state.mailboxReady).toBe(T0 - 5000);
		expect(state.welcomedAt).toBe(T0 - 6000);
	});

	it('as Undo, leaves a later dismissal in place', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.userId = 'member-a';
		await t.run(async (ctx) => {
			await ctx.db.insert('userOnboarding', {
				authUserId: 'member-a',
				dismissedAt: T0 + 5000,
				createdAt: T0,
				updatedAt: T0 + 5000,
			});
		});

		const restored = await t.mutation(api.auth.userOnboarding.restore, {
			userId: 'member-a',
			dismissedAt: T0,
		});
		expect(restored).toEqual({ isDismissed: true });
		const state = await t.query(api.auth.userOnboarding.get, { userId: 'member-a' });
		expect(state.dismissedAt).toBe(T0 + 5000);
	});

	it('is a no-op for a member with no row, and creates none', async () => {
		const t = convexTest(schema, modules);
		sessionMocks.userId = 'member-a';

		expect(await t.mutation(api.auth.userOnboarding.restore, { userId: 'member-a' })).toEqual({
			isDismissed: false,
		});
		expect(await t.mutation(api.auth.userOnboarding.restore, { userId: 'member-a' })).toEqual({
			isDismissed: false,
		});
		const rows = await t.run(async (ctx) => ctx.db.query('userOnboarding').collect());
		expect(rows).toHaveLength(0);
	});

	it("rejects restoring another user's checklist", async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('userOnboarding', {
				authUserId: 'member-b',
				dismissedAt: T0,
				createdAt: T0,
				updatedAt: T0,
			});
		});
		sessionMocks.userId = 'member-a';

		await expect(
			t.mutation(api.auth.userOnboarding.restore, { userId: 'member-b' })
		).rejects.toThrow(/not self/);
		const row = await t.run(async (ctx) => ctx.db.query('userOnboarding').first());
		expect(row?.dismissedAt).toBe(T0);
	});
});
