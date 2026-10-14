/**
 * The scheduled pages of `clarificationHold.syncHeldClarifications`: a thread
 * with more held messages than one transaction updates continues here.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { syncHeldPage } from './clarificationHold';

/**
 * The next page. It applies the thread's status as it is NOW, not as it was
 * when the page was scheduled, so a settle and a reopen racing each other
 * always end on the thread's last state.
 */
export const syncHeldClarificationsPage = internalMutation({
	args: { threadId: v.id('conversationThreads'), after: v.number() },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		await syncHeldPage(ctx, args.threadId, thread.status, args.after);
	},
});
