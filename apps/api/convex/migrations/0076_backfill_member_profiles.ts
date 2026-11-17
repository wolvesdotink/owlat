/**
 * Write the missing profile of every org member (migration 0076).
 *
 *   npx convex run migrations/0076_backfill_member_profiles:run
 *
 * A `userProfiles` row is what the app reads as org membership
 * (lib/userProfiles.ts). On an install that requires a confirmed address,
 * sign-up returns no session, so the sign-up page never wrote the row, and
 * the person joined through the invitation without one: BetterAuth lists them
 * as a member, but every membership write (team inboxes, chat, assignment)
 * refuses them. Accepting an invitation now writes the row (`auth/auth.ts`);
 * this writes it for the members who joined before.
 *
 * One transaction: membership is capped (`membershipLimit` in `auth/auth.ts`),
 * so the whole `member` table fits in a few adapter pages. A profile that
 * exists is left as it is, soft-deleted included, so an erasure in progress is
 * never undone. Its cron starts it on every install; once completed it costs
 * one indexed read.
 */

import { internalMutation } from '../lib/writeFence';
import { logInfo, logWarn } from '../lib/runtimeLog';
import { beginMigrationRun, readMigrationRun, recordMigrationPage } from '../lib/migrationLedger';
import { components } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { ensureUserProfile } from '../auth/userProfiles';

export const MIGRATION = '0076_backfill_member_profiles';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.22';

const PAGE_SIZE = 100;

type MemberRow = { _id: string; userId: string };
type UserRow = { _id: string; email?: string; name?: string | null };

interface RunResult {
	started: boolean;
	reason?: string;
}

async function hasProfile(ctx: MutationCtx, authUserId: string): Promise<boolean> {
	const row = await ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
	return row !== null;
}

async function backfill(ctx: MutationCtx): Promise<RunResult> {
	const run = await beginMigrationRun(ctx, { migration: MIGRATION, introducedIn: INTRODUCED_IN });
	if (!run) return { started: false, reason: 'Already completed' };
	let cursor: string | null = null;
	let scanned = 0;
	let created = 0;
	for (;;) {
		const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
			model: 'member',
			where: [],
			paginationOpts: { cursor, numItems: PAGE_SIZE },
		})) as { page: MemberRow[]; continueCursor: string; isDone: boolean };
		for (const member of result.page) {
			scanned++;
			if (await hasProfile(ctx, member.userId)) continue;
			const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
				model: 'user',
				where: [{ field: '_id', value: member.userId }],
			})) as UserRow | null;
			// A membership whose login identity is gone has no person to write a
			// profile for, and nobody can act through it; erasure removes it.
			if (!user?.email) {
				logWarn('migration.0076_backfill_member_profiles.orphan_member', {
					memberId: member._id,
				});
				continue;
			}
			await ensureUserProfile(ctx, {
				authUserId: member.userId,
				email: user.email,
				name: user.name || undefined,
			});
			created++;
		}
		if (result.isDone) break;
		cursor = result.continueCursor;
	}
	await recordMigrationPage(ctx, run, {
		cursor: 'done',
		isDone: true,
		scanned,
		changed: created,
	});
	logInfo('migration.0076_backfill_member_profiles.completed', { scanned, created });
	return { started: true };
}

/** The runner's and the CLI's entry point. */
export const run = internalMutation({
	args: {},
	handler: (ctx): Promise<RunResult> => backfill(ctx),
});

/** The cron's entry point: {@link run} until it has completed once. */
export const ensure = internalMutation({
	args: {},
	handler: async (ctx): Promise<RunResult> => {
		const existing = await readMigrationRun(ctx, MIGRATION);
		if (existing?.status === 'completed') return { started: false };
		return await backfill(ctx);
	},
});
