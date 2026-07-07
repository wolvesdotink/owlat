/**
 * `POST /dev/reset` — wipe the instance back to a blank slate so the signup
 * flow at `/auth/register` can be exercised end-to-end without
 * `docker compose down -v`.
 *
 * Deletes EVERYTHING tenant-side, not just seed-tagged rows — the goal is a
 * blank instance, so a developer who hand-created content through the live
 * UI does not get an orphaned dataset after reset. The table list is the shared
 * `TENANT_TABLES` from `lib/tenantTables.ts` (also used by account deletion).
 *
 * Order of operations:
 *   1. Wipe all tenant tables (contacts/automations/templates/campaigns/…)
 *   2. Wipe BetterAuth tables (user/account/organization/member)
 *   3. Wipe Owlat-local auth tables (userProfiles/instanceSettings/onboardingProgress)
 *
 * Protected by:
 *   - X-Instance-Secret header (timing-safe compare)
 *   - `assertDevDeployment()` — refuses unless `OWLAT_DEV_MODE` is enabled
 *
 * Idempotent: a second call against a blank instance returns zeros for every
 * counter.
 */

import { httpAction, internalMutation, type MutationCtx } from '../_generated/server';
import { components, internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { safeCompare } from '../lib/safeCompare';
import { devDeploymentResponseOrNull } from './_guard';
import { TENANT_TABLES } from '../lib/tenantTables';

interface ResetCounts {
	users: number;
	accounts: number;
	organizations: number;
	members: number;
	userProfiles: number;
	instanceSettings: number;
	onboardingProgress: number;
	tenantRows: number;
}

export const runReset = internalMutation({
	args: {},
	handler: async (ctx): Promise<ResetCounts> => {
		const counts: ResetCounts = {
			users: 0,
			accounts: 0,
			organizations: 0,
			members: 0,
			userProfiles: 0,
			instanceSettings: 0,
			onboardingProgress: 0,
			tenantRows: 0,
		};

		// 1. Wipe all tenant tables.
		for (const table of TENANT_TABLES) {
			const rows = await ctx.db.query(table).collect(); // bounded: dev-only full wipe of each tenant table
			for (const row of rows) {
				await ctx.db.delete(row._id);
				counts.tenantRows++;
			}
		}

		// 2. Wipe BetterAuth tables via the component adapter. Order matters:
		// dependants (member) before parents (user/organization).
		counts.members = await wipeBetterAuthModel(ctx, 'member');
		counts.organizations = await wipeBetterAuthModel(ctx, 'organization');
		counts.accounts = await wipeBetterAuthModel(ctx, 'account');
		counts.users = await wipeBetterAuthModel(ctx, 'user');

		// 3. Wipe Owlat-local auth tables.
		const profiles = await ctx.db.query('userProfiles').collect(); // bounded: dev-only; org member roster (tiny)
		for (const p of profiles) {
			await ctx.db.delete(p._id);
			counts.userProfiles++;
		}

		const settings = await ctx.db.query('instanceSettings').collect(); // bounded: dev-only; singleton instance-settings row
		for (const s of settings) {
			await ctx.db.delete(s._id);
			counts.instanceSettings++;
		}

		const onboarding = await ctx.db.query('onboardingProgress').collect(); // bounded: dev-only; one row per user
		for (const o of onboarding) {
			await ctx.db.delete(o._id);
			counts.onboardingProgress++;
		}

		return counts;
	},
});

/**
 * Drain a BetterAuth model by re-querying from cursor=null after each batch
 * delete. Re-querying (instead of following `continueCursor`) avoids the
 * cursor-anchor-deleted pathology when we delete the page we just fetched.
 *
 * Defensive max-iteration cap: dev/selfhost instances should never hold more
 * than a few hundred auth rows, but keep the upper bound explicit so a
 * misbehaving adapter can't hang the mutation forever.
 */
async function wipeBetterAuthModel(
	ctx: MutationCtx,
	model: 'user' | 'account' | 'organization' | 'member',
): Promise<number> {
	let total = 0;
	const MAX_ITERATIONS = 200;
	for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
		const result: { page: Array<{ _id: string }>; isDone: boolean; continueCursor: string } =
			await ctx.runQuery(components.betterAuth.adapter.findMany, {
				model,
				where: [],
				paginationOpts: { cursor: null, numItems: 100 },
			} as unknown as Parameters<typeof ctx.runQuery>[1]);
		const rows = result?.page ?? [];
		if (rows.length === 0) break;
		for (const row of rows) {
			await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
				input: {
					model,
					where: [{ field: '_id', value: row._id }],
				},
			} as unknown as Parameters<typeof ctx.runMutation>[1]);
			total++;
		}
		// Loop continues: re-query with cursor=null picks up whatever's left.
	}
	return total;
}

export const resetHttp = httpAction(async (ctx, request) => {
	const devResp = devDeploymentResponseOrNull();
	if (devResp) return devResp;

	const secret = request.headers.get('X-Instance-Secret');
	const expected = getOptional('INSTANCE_SECRET');
	if (!expected || !secret || !safeCompare(secret, expected)) {
		return jsonResponse({ error: 'Unauthorized' }, 401);
	}

	try {
		const counts = await ctx.runMutation(internal.devShortcuts.reset.runReset, {});
		return jsonResponse({ deleted: counts }, 200);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Internal error';
		return jsonResponse({ error: message }, 500);
	}
});

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
