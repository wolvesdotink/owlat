/**
 * Scheduled pages of the held-question bookkeeping (./clarificationHold.ts):
 * a thread's held messages after a settle or reopen, and a settled question's
 * notices.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { clearNoticesPage, syncHeldPage } from './clarificationHold';

/**
 * The next page, from `cursor` (null: from the start). Paged with Convex's
 * own cursor, which breaks ties between rows created in the same instant; it
 * applies the thread's status at the moment it runs (`syncHeldPage`).
 */
export const syncHeldClarificationsPage = internalMutation({
	args: {
		threadId: v.id('conversationThreads'),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args) => {
		await syncHeldPage(ctx, args.threadId, args.cursor);
	},
});

/**
 * A settled question's notices, a page at a time (`clarificationHold.
 * clearClarificationReminders`): only those written up to `before`.
 */
export const clearClarificationNotices = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		before: v.number(),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args) => {
		await clearNoticesPage(ctx, args.inboundMessageId, args.before, args.cursor);
	},
});
