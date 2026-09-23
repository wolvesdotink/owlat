/**
 * Per-user thread visits — "when did I last open this conversation?"
 *
 * Read flags on a shared mailbox are shared, so they cannot tell whether THIS
 * member has seen what a teammate already opened. A visit row per (user,
 * thread) can: a thread whose `messageCount` grew past the count recorded at
 * the visit "moved without me". That feeds the sidebar's "Updated" pill and
 * Today's "What changed" band. The row is written when the reader opens a
 * thread; nothing else changes.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';

export async function loadThreadVisit(
	ctx: QueryCtx,
	userId: string,
	threadId: Id<'mailThreads'>
): Promise<Doc<'mailThreadVisits'> | null> {
	return ctx.db
		.query('mailThreadVisits')
		.withIndex('by_user_and_thread', (q) => q.eq('userId', userId).eq('threadId', threadId))
		.unique();
}

/**
 * How a thread relates to the viewer's last visit. `messageCount` is compared
 * rather than `lastMessageAt` so a flag change or a re-sort never reads as news.
 */
export function visitDelta(
	thread: Pick<Doc<'mailThreads'>, 'messageCount' | 'lastMessageAt'>,
	visit: Pick<Doc<'mailThreadVisits'>, 'messageCount' | 'visitedAt'> | null
): { isVisited: boolean; newSinceVisit: number } {
	if (!visit) return { isVisited: false, newSinceVisit: 0 };
	const grown = Math.max(0, thread.messageCount - visit.messageCount);
	return { isVisited: true, newSinceVisit: thread.lastMessageAt > visit.visitedAt ? grown : 0 };
}

/** Record that the caller opened a thread (upsert; cheap enough per open). */
// authz: thread → mailbox access via requireMailboxAccess; the row is keyed to
// the caller's own user id, so it can only ever describe their own reading.
export const recordVisit = postboxMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const access = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!access.ok) throwForbidden('Thread not accessible');
		const now = Date.now();
		const existing = await loadThreadVisit(ctx, access.userId, args.threadId);
		if (existing) {
			if (existing.messageCount === thread.messageCount && now - existing.visitedAt < 60_000) {
				return { success: true };
			}
			await ctx.db.patch(existing._id, { visitedAt: now, messageCount: thread.messageCount });
			return { success: true };
		}
		await ctx.db.insert('mailThreadVisits', {
			userId: access.userId,
			threadId: args.threadId,
			mailboxId: thread.mailboxId,
			visitedAt: now,
			messageCount: thread.messageCount,
		});
		return { success: true };
	},
});
