/**
 * Per-user thread read state — the unread counterpart to chat's
 * `chatRoomMembers.lastReadAt`, for the shared-inbox team view.
 *
 * A `threadReads` row records the last time a given team member OPENED a thread.
 * The team-inbox list (`inbox/queries.ts → listThreads`) compares each thread's
 * `lastMessageAt` against the caller's `lastSeenAt` to decide whether the row is
 * unread FOR THEM — so two teammates can each have their own unread state on the
 * same shared thread, exactly like chat.
 *
 * This is a read-side badge only: opening a thread marks it seen, it never gates
 * a mutation, and — like presence — it records NO audit-log entry. The shared
 * inbox can be read by any organization member, so the per-user marker uses
 * the member-authenticated mutation floor.
 */

import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { getMutationContext } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';

/**
 * Mark a thread as seen by the caller (upsert `lastSeenAt = now`). Called when a
 * team member opens the thread detail view. Idempotent: re-opening a thread just
 * advances the timestamp. One row per (user, thread).
 */
// all-members: every member may read the shared inbox, and this only updates the caller's marker.
export const markThreadSeen = authedMutation({
	args: {
		threadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		// A read marker for a deleted / non-existent thread is a no-op error, the
		// same guard the neighbouring presence heartbeat applies.
		await getOrThrow(ctx, args.threadId, 'Thread');

		const now = Date.now();
		const existing = await ctx.db
			.query('threadReads')
			.withIndex('by_user_thread', (q) => q.eq('userId', userId).eq('threadId', args.threadId))
			.unique();

		if (existing) {
			await ctx.db.patch(existing._id, { lastSeenAt: now });
		} else {
			await ctx.db.insert('threadReads', {
				threadId: args.threadId,
				userId,
				lastSeenAt: now,
			});
		}
		return { success: true };
	},
});
