/**
 * Fill the thread-row copies plan C8 added (migration 0047).
 *
 *   - `mailThreads.latestSnoozedUntil`: the snooze of the thread's newest
 *     message, so the conversation list stops loading that message per row.
 *   - `mailThreads.needsReply.trigger`: the trigger message's sender, subject
 *     and arrival time, so the Reply Queue stops loading it per row.
 *
 * The code that shipped with it already writes both on every relevant change
 * and falls back to the message when a copy is missing, so this migration is
 * not needed for correctness; it moves the old rows onto the fast path.
 * Background, idempotent and safe to re-run: only rows still missing a copy are
 * touched, so a value written since the deploy is never overwritten.
 *
 *   npx convex run migrations/0047_denormalize_thread_rows:run
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { readLatestSnoozedUntil } from '../mail/threadLatestSnooze';
import { needsReplyTriggerOf } from '../mail/needsReplyTrigger';
import { logInfo } from '../lib/runtimeLog';

const PAGE_SIZE = 100;

type PageResult = { snooze: number; triggers: number; cursor: string; isDone: boolean };

export const backfillPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor }): Promise<PageResult> => {
		const result = await ctx.db.query('mailThreads').paginate({ numItems: PAGE_SIZE, cursor });
		let snooze = 0;
		let triggers = 0;
		for (const thread of result.page) {
			const patch: Partial<Pick<Doc<'mailThreads'>, 'latestSnoozedUntil' | 'needsReply'>> = {};
			if (thread.latestSnoozedUntil === undefined) {
				patch.latestSnoozedUntil = await readLatestSnoozedUntil(ctx, thread);
				snooze++;
			}
			const flag = thread.needsReply;
			if (flag && flag.trigger === undefined) {
				const message = await ctx.db.get(flag.messageId);
				if (message) {
					patch.needsReply = { ...flag, trigger: needsReplyTriggerOf(message) };
					triggers++;
				}
			}
			if (Object.keys(patch).length > 0) await ctx.db.patch(thread._id, patch);
		}
		return { snooze, triggers, cursor: result.continueCursor, isDone: result.isDone };
	},
});

export const run = internalAction({
	args: {},
	handler: async (ctx): Promise<{ snooze: number; triggers: number }> => {
		let cursor: string | null = null;
		let snooze = 0;
		let triggers = 0;
		for (;;) {
			const page: PageResult = await ctx.runMutation(
				internal.migrations['0047_denormalize_thread_rows'].backfillPage,
				{ cursor }
			);
			snooze += page.snooze;
			triggers += page.triggers;
			if (page.isDone) break;
			cursor = page.cursor;
		}
		const result = { snooze, triggers };
		logInfo('migration.0047_denormalize_thread_rows', result);
		return result;
	},
});
