/**
 * Team Inbox conversation priority — a person marks a thread urgent (or low),
 * from the thread page or the command palette.
 *
 * Admin-only like every other write on the shared inbox, behind the `inbox`
 * flag (a disabled Team Inbox accepts no writes), and audited. `normal`
 * clears the field instead of storing it (see `teamThreadPriorityValidator`), so
 * "never set" and "set back to normal" are the same row.
 */

import { v } from 'convex/values';
import { getOrThrow } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { teamThreadPriorityValidator } from '../lib/validators/teamThreadPriority';
import { teamInboxAdminMutation } from './sla/policy';

/** Set a thread's priority. A no-op (and no audit row) when it already has it. */
export const setThreadPriority = teamInboxAdminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		priority: teamThreadPriorityValidator,
	},
	handler: async (ctx, args, session) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const from = thread.priority ?? 'normal';
		if (from === args.priority) return { changed: false };
		await ctx.db.patch(args.threadId, {
			priority: args.priority === 'normal' ? undefined : args.priority,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			action: 'thread.priority_changed',
			resource: 'conversation_thread',
			resourceId: args.threadId,
			details: { from, to: args.priority },
		});
		return { changed: true };
	},
});
