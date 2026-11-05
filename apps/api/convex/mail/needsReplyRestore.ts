/**
 * Undo of `needsReply.clear`: the flag it kept aside comes back as it was. The
 * server holds the flag, so a caller cannot write one of its own; a flag that
 * arrived since the clear wins and the kept one is dropped. Its own module
 * because `needsReply.ts` sits at the domain-file size cap.
 */
import { v } from 'convex/values';
import { postboxMutation } from './_helpers';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { refreshArrivalProjection } from './arrival/projection';

// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const restore = postboxMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		const kept = thread.needsReplyCleared;
		const isFree = thread.needsReply === undefined;
		await ctx.db.patch(args.threadId, {
			needsReplyCleared: undefined,
			needsReplyClearedAt: undefined,
			...(kept && isFree ? { needsReply: kept, updatedAt: Date.now() } : {}),
		});
		if (kept && isFree) await refreshArrivalProjection(ctx, args.threadId);
	},
});
