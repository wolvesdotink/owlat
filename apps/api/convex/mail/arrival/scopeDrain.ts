/**
 * The rest of a shared thread's arrival records after a scope conversion
 * (`purge.ts clearSharedThreadArrival` deletes the first page inline), a page
 * per transaction until none are left.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { deleteThreadRecordsPage } from './purge';

export const drainThreadRecords = internalMutation({
	args: { threadId: v.id('mailThreads') },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		if (!(await deleteThreadRecordsPage(ctx, args.threadId))) {
			await ctx.scheduler.runAfter(0, internal.mail.arrival.scopeDrain.drainThreadRecords, args);
		}
		return null;
	},
});
