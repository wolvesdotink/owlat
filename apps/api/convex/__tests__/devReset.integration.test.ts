/**
 * Integration tests for `POST /dev/reset` — the dev-only "back to a blank
 * instance" endpoint.
 *
 * The property under test is completeness. A table the wipe forgets survives
 * into what is supposed to be a fresh install, and the two onboarding tables
 * added with the send-ready notices are exactly the kind that go unnoticed:
 * they are in `NON_TENANT_TABLES` (so the tenant walker skips them) and they
 * are keyed by a BetterAuth user id that no longer exists after the wipe.
 * A leftover pending notice would toast the first account created afterwards,
 * and a leftover readiness sample would make a blank instance look like sending
 * was already known-good, so the edge detector would see no edge and never
 * notify anyone.
 *
 * The BetterAuth component is registered because `runReset` drains its models
 * through the adapter.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import betterAuthSchema from '../betterAuth/schema';
import { internal } from '../_generated/api';

const modules = import.meta.glob('../**/*.*s');
const betterAuthModules = import.meta.glob('../betterAuth/**/*.*s');

const SECRET = 'dev-reset-test-secret-at-least-32-characters';

function newHarness(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', SECRET);
	vi.stubEnv('OWLAT_DEV_MODE', 'true');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('dev reset — onboarding notice tables', () => {
	it('wipes sendReadyNotices and sendPathReadiness and counts them', async () => {
		const t = newHarness();
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('sendReadyNotices', { userId: 'auth-user-1', createdAt: now });
			await ctx.db.insert('sendReadyNotices', {
				userId: 'auth-user-2',
				createdAt: now,
				acknowledgedAt: now,
			});
			await ctx.db.insert('sendPathReadiness', { isReady: true, changedAt: now });
			await ctx.db.insert('userOnboarding', {
				authUserId: 'auth-user-1',
				createdAt: now,
				updatedAt: now,
			});
		});

		const counts = await t.mutation(internal.devShortcuts.reset.runReset, {});
		expect(counts.sendReadyNotices).toBe(2);
		expect(counts.sendPathReadiness).toBe(1);
		expect(counts.userOnboarding).toBe(1);

		const left = await t.run(async (ctx) => ({
			notices: await ctx.db.query('sendReadyNotices').collect(),
			readiness: await ctx.db.query('sendPathReadiness').collect(),
		}));
		expect(left.notices).toEqual([]);
		expect(left.readiness).toEqual([]);
	});

	it('is idempotent — a second reset reports zeros', async () => {
		const t = newHarness();
		await t.run(async (ctx) => {
			await ctx.db.insert('sendPathReadiness', { isReady: false, changedAt: Date.now() });
		});

		await t.mutation(internal.devShortcuts.reset.runReset, {});
		const second = await t.mutation(internal.devShortcuts.reset.runReset, {});
		expect(second.sendReadyNotices).toBe(0);
		expect(second.sendPathReadiness).toBe(0);
	});
});
