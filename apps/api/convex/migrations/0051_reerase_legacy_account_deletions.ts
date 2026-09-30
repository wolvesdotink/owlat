/**
 * Finish the erasure of accounts whose deletion was marked `completed` before
 * erasures were persisted and covered the login identity.
 *
 * Those requests were closed while the BetterAuth identity (user, password,
 * sessions, passkeys, TOTP secret) was never touched, and a member's private
 * assistant conversations and uploaded mail archives were never visited. Some
 * were closed with nothing done at all: the daily run took a missing profile
 * as proof of completion. None recorded whose account it was.
 *
 * An operator runs `convex run migrations/0051_reerase_legacy_account_deletions:run`
 * once. It walks `completed` requests that carry no `authUserId`, recovers the
 * subject the same conservative way the daily run does
 * (`auth/erasure/lifecycle.ts` `recoverErasureSubject`: exactly one identity
 * with the address, older than the request, with no profile and no
 * membership), and re-opens the request as `erasing` with a persisted job.
 * Every erasure phase is idempotent, so what was already erased is a no-op.
 * A request whose subject cannot be recovered is left as it is and counted.
 * Idempotent: a re-opened request carries its `authUserId` and is skipped by
 * the next run.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { logInfo } from '../lib/runtimeLog';
import { beginMemberErasure, recoverErasureSubject } from '../auth/erasure/lifecycle';

/** Requests per page; each may start one erasure job. */
const PAGE_SIZE = 25;

export const reopenPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (
		ctx,
		args
	): Promise<{ reopened: number; skipped: number; cursor: string; isDone: boolean }> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('accountDeletionRequests')
			.withIndex('by_status', (q) => q.eq('status', 'completed'))
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });

		let reopened = 0;
		let skipped = 0;
		for (const request of page) {
			if (request.authUserId !== undefined) continue;
			const recovery = await recoverErasureSubject(ctx, request);
			if (!recovery.ok) {
				skipped++;
				continue;
			}
			await beginMemberErasure(ctx, request._id, {
				authUserId: recovery.authUserId,
				email: request.email,
			});
			reopened++;
		}
		return { reopened, skipped, cursor: continueCursor, isDone };
	},
});

export const run = internalAction({
	args: {},
	handler: async (ctx): Promise<{ reopened: number; skipped: number }> => {
		let cursor: string | null = null;
		let reopened = 0;
		let skipped = 0;
		for (;;) {
			const page: { reopened: number; skipped: number; cursor: string; isDone: boolean } =
				await ctx.runMutation(
					internal.migrations['0051_reerase_legacy_account_deletions'].reopenPage,
					{ cursor }
				);
			reopened += page.reopened;
			skipped += page.skipped;
			if (page.isDone) break;
			cursor = page.cursor;
		}
		logInfo('migration.0051_reerase_legacy_account_deletions', { reopened, skipped });
		return { reopened, skipped };
	},
});
