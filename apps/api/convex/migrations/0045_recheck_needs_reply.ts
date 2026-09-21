/**
 * One-shot Reply Queue re-check.
 *
 * The needs-reply screen was tightened (mail/needsReplyHeuristic.ts +
 * mail/ai/replyIntent.ts) so meeting notes, recaps, receipts and other
 * informational mail stop asking for a reply. Threads flagged under the old
 * rules keep their flag until something touches them, so an operator runs
 * `convex run migrations/0045_recheck_needs_reply:run '{"mailboxId":"..."}'`
 * to re-classify the current queue against the new rules.
 *
 * The candidate read is bounded (one queue page) and re-enqueueing is
 * idempotent, so the migration is safe to re-run.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';

export const run = internalAction({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ scheduled: number }> => {
		const threadIds = await ctx.runQuery(internal.mail.needsReply.listFlaggedThreads, {
			mailboxId: args.mailboxId,
		});
		for (const threadId of threadIds) {
			await ctx.runMutation(internal.mail.needsReply.requeue, { threadId });
		}
		return { scheduled: threadIds.length };
	},
});
