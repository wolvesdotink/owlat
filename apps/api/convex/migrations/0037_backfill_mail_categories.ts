/**
 * One-shot smart-inbox category backfill.
 *
 * An operator runs
 * `convex run migrations/0037_backfill_mail_categories:run '{"mailboxId":"..."}'`.
 * The underlying candidate read is bounded and enqueueing is idempotent, so the
 * migration is safe to resume.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';

export const run = internalAction({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ scheduled: number }> => {
		const threadIds = await ctx.runQuery(internal.mail.category.listUnclassifiedInbox, {
			mailboxId: args.mailboxId,
		});
		for (const threadId of threadIds) {
			await ctx.runMutation(internal.mail.category.enqueue, { threadId });
		}
		return { scheduled: threadIds.length };
	},
});
