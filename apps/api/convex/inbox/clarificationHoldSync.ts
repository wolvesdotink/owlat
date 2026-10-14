/**
 * The scheduled pages of `clarificationHold.syncHeldClarifications`: a thread
 * with more held messages than one transaction updates continues here.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { syncHeldPage } from './clarificationHold';

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
