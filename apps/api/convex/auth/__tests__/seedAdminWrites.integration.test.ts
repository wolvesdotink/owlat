/**
 * What `POST /seed/admin` writes: the BetterAuth user, credential account,
 * organization and owner membership, the user profile, the instance settings
 * row with its one-shot latch, the initial platform-admin grant and the
 * wizard's feature flags. And what it refuses: a second seed once a user
 * exists, and any seed once the latch is stamped, even with no user left.
 */

import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { components } from '../../_generated/api';
import { newBetterAuthHarness } from '../../__tests__/testModules';

const SECRET = 'seed-admin-test-instance-secret';

function harness() {
	const t = newBetterAuthHarness();
	rateLimiterTest.register(t);
	return t;
}

type Harness = ReturnType<typeof harness>;

async function seed(t: Harness, body: Record<string, unknown>) {
	const res = await t.fetch('/seed/admin', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Instance-Secret': SECRET },
		body: JSON.stringify(body),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function authRows(t: Harness, model: string): Promise<Array<Record<string, unknown>>> {
	const result = (await t.query(components.betterAuth.adapter.findMany, {
		model,
		where: [],
		paginationOpts: { cursor: null, numItems: 10 },
	} as never)) as { page?: Array<Record<string, unknown>> };
	return result.page ?? [];
}

async function appRows(t: Harness) {
	return await t.run(async (ctx) => ({
		profiles: await ctx.db.query('userProfiles').collect(),
		settings: await ctx.db.query('instanceSettings').collect(),
		admins: await ctx.db.query('platformAdmins').collect(),
	}));
}

const ADMIN = { email: 'Admin@Example.com', name: 'Ada', passwordHash: 'salt:hash' };

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('POST /seed/admin writes', () => {
	it('seeds the first admin, their organization and the instance on a fresh deployment', async () => {
		const t = harness();

		const res = await seed(t, ADMIN);

		expect(res.status).toBe(201);
		const userId = res.json['userId'];
		expect(res.json).toEqual({ success: true, userId: expect.any(String) });

		const [user, ...moreUsers] = await authRows(t, 'user');
		expect(moreUsers).toEqual([]);
		expect(user).toMatchObject({
			_id: userId,
			email: ADMIN.email,
			name: ADMIN.name,
			emailVerified: true,
		});
		expect(await authRows(t, 'account')).toEqual([
			expect.objectContaining({
				userId,
				providerId: 'credential',
				accountId: userId,
				password: ADMIN.passwordHash,
			}),
		]);
		const [organization, ...moreOrganizations] = await authRows(t, 'organization');
		expect(moreOrganizations).toEqual([]);
		expect(organization).toMatchObject({ name: "Ada's Team", slug: 'admin' });
		expect(await authRows(t, 'member')).toEqual([
			expect.objectContaining({ userId, organizationId: organization!['_id'], role: 'owner' }),
		]);

		const rows = await appRows(t);
		expect(rows.profiles).toEqual([
			expect.objectContaining({ authUserId: userId, email: 'admin@example.com', name: 'Ada' }),
		]);
		expect(rows.settings).toHaveLength(1);
		expect(rows.settings[0]).toMatchObject({
			timezone: 'UTC',
			defaultFromName: "Ada's Team",
			isMigrationMode: false,
			adminSeedCompletedAt: expect.any(Number),
		});
		expect(rows.settings[0]?.featureFlags).toBeUndefined();
		expect(rows.admins).toEqual([
			expect.objectContaining({
				authUserId: userId,
				email: 'admin@example.com',
				role: 'superadmin',
			}),
		]);
	});

	it('persists the wizard flags and the migration answer', async () => {
		const t = harness();

		const res = await seed(t, {
			...ADMIN,
			flags: { campaigns: true, inbox: false },
			isMigrationMode: true,
		});

		expect(res.status).toBe(201);
		const [settings] = (await appRows(t)).settings;
		expect(settings).toMatchObject({ isMigrationMode: true });
		expect(settings?.featureFlags?.['campaigns']).toBe(true);
		expect(settings?.featureFlags?.['inbox']).toBe(false);
	});

	it('falls back to the `org` slug when the email local part has no slug characters', async () => {
		const t = harness();

		expect((await seed(t, { ...ADMIN, email: '+++@example.com' })).status).toBe(201);

		expect(await authRows(t, 'organization')).toEqual([expect.objectContaining({ slug: 'org' })]);
	});

	it('fills the seed columns onto a settings row a cron created first', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { createdAt: Date.now() });
		});

		expect((await seed(t, ADMIN)).status).toBe(201);

		const { settings } = await appRows(t);
		expect(settings).toHaveLength(1);
		expect(settings[0]).toMatchObject({
			timezone: 'UTC',
			defaultFromName: "Ada's Team",
			isMigrationMode: false,
			adminSeedCompletedAt: expect.any(Number),
		});
	});

	it('keeps an existing platform admin and grants nobody else', async () => {
		const t = harness();
		await t.run(async (ctx) => {
			await ctx.db.insert('platformAdmins', {
				authUserId: 'earlier-operator',
				email: 'operator@example.com',
				role: 'superadmin',
				createdAt: Date.now(),
			});
		});

		expect((await seed(t, ADMIN)).status).toBe(201);

		expect((await appRows(t)).admins).toEqual([
			expect.objectContaining({ authUserId: 'earlier-operator' }),
		]);
	});

	it('refuses a second seed once a user exists and writes nothing more', async () => {
		const t = harness();
		expect((await seed(t, ADMIN)).status).toBe(201);
		const before = await appRows(t);

		const second = await seed(t, { ...ADMIN, email: 'other@example.com', name: 'Other' });

		expect(second).toEqual({
			status: 409,
			json: {
				error: {
					category: 'already_exists',
					message: 'Users already exist. Seed endpoint is one-shot only.',
				},
			},
		});
		expect(await authRows(t, 'user')).toHaveLength(1);
		expect(await authRows(t, 'organization')).toHaveLength(1);
		expect(await appRows(t)).toEqual(before);
	});

	it('refuses once the latch is stamped, even after every user is gone', async () => {
		const t = harness();
		const stampedAt = Date.now() - 60_000;
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				createdAt: stampedAt,
				adminSeedCompletedAt: stampedAt,
			});
		});

		const res = await seed(t, ADMIN);

		expect(res).toEqual({
			status: 409,
			json: {
				error: {
					category: 'already_exists',
					message: 'Admin seed has already completed on this instance.',
				},
			},
		});
		expect(await authRows(t, 'user')).toEqual([]);
		expect(await authRows(t, 'organization')).toEqual([]);
		const rows = await appRows(t);
		expect(rows.profiles).toEqual([]);
		expect(rows.admins).toEqual([]);
		expect(rows.settings).toEqual([
			expect.objectContaining({ adminSeedCompletedAt: stampedAt, createdAt: stampedAt }),
		]);
		expect(rows.settings[0]?.timezone).toBeUndefined();
	});
});
