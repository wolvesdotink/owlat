/**
 * The `/seed/admin` commit on its own: it re-checks both one-shot guards in
 * its own transaction (the route's probes ran in earlier ones), and a seed
 * that fails part-way writes nothing, so the instance can be seeded again.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { components, internal } from '../../_generated/api';
import { newBetterAuthHarness } from '../../__tests__/testModules';
import { planAdminSeed, type AdminSeed } from '../seedAdminDecision';

const SECRET = 'seed-admin-commit-test-secret';

function harness() {
	const t = newBetterAuthHarness();
	rateLimiterTest.register(t);
	return t;
}

type Harness = ReturnType<typeof harness>;

function seedFor(body: Parameters<typeof planAdminSeed>[0]): AdminSeed {
	const plan = planAdminSeed(body);
	if (!plan.ok) throw new Error('test seed must be valid');
	return plan.seed;
}

const SEED = seedFor({ email: 'admin@example.com', name: 'Ada', passwordHash: 'salt:hash' });

async function userCount(t: Harness): Promise<number> {
	const result = (await t.query(components.betterAuth.adapter.findMany, {
		model: 'user',
		where: [],
		paginationOpts: { cursor: null, numItems: 10 },
	} as never)) as { page?: unknown[] };
	return result.page?.length ?? 0;
}

async function appRows(t: Harness) {
	return await t.run(async (ctx) => ({
		profiles: await ctx.db.query('userProfiles').collect(),
		settings: await ctx.db.query('instanceSettings').collect(),
		admins: await ctx.db.query('platformAdmins').collect(),
	}));
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('commitAdminSeed', () => {
	it('refuses when a user landed after the route probed', async () => {
		const t = harness();
		await t.mutation(components.betterAuth.adapter.create, {
			input: {
				model: 'user',
				data: {
					email: 'early@example.com',
					name: 'Early',
					emailVerified: true,
					createdAt: 1,
					updatedAt: 1,
				},
			},
		} as never);

		expect(await t.mutation(internal.auth.seedAdminCommit.commitAdminSeed, SEED)).toEqual({
			outcome: 'users_exist',
		});
		expect(await userCount(t)).toBe(1);
		expect(await appRows(t)).toEqual({ profiles: [], settings: [], admins: [] });
	});

	it('refuses when another seed stamped the latch after the route probed', async () => {
		const t = harness();
		await t.mutation(internal.workspaces.settings.claimAdminSeedInternal, {});

		expect(await t.mutation(internal.auth.seedAdminCommit.commitAdminSeed, SEED)).toEqual({
			outcome: 'already_seeded',
		});
		expect(await userCount(t)).toBe(0);
		const rows = await appRows(t);
		expect(rows.profiles).toEqual([]);
		expect(rows.admins).toEqual([]);
		expect(rows.settings[0]?.defaultFromName).toBeUndefined();
	});

	it('writes nothing when the seed fails part-way, so a corrected seed still succeeds', async () => {
		const t = harness();
		const failing = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Instance-Secret': SECRET },
			body: JSON.stringify({
				email: 'admin@example.com',
				name: 'Ada',
				passwordHash: 'salt:hash',
				flags: { 'not.a.flag': true },
			}),
		});

		expect(failing.status).toBe(500);
		expect(await failing.json()).toEqual({
			error: { category: 'internal', message: 'Internal error' },
		});
		expect(await userCount(t)).toBe(0);
		expect(await appRows(t)).toEqual({ profiles: [], settings: [], admins: [] });

		const retry = await t.fetch('/seed/admin', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Instance-Secret': SECRET },
			body: JSON.stringify({ email: 'admin@example.com', name: 'Ada', passwordHash: 'salt:hash' }),
		});
		expect(retry.status).toBe(201);
		expect(await userCount(t)).toBe(1);
		expect((await appRows(t)).admins).toHaveLength(1);
	});
});
