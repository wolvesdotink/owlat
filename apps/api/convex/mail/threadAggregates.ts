/**
 * Thread aggregate rebuild — the one place a `mailThreads` row is re-derived
 * from the messages it actually contains.
 *
 * Split out of `mail/messageActions.ts` (size cap) rather than duplicated: the
 * triage mutations, the retroactive filter sweep, the follow-up watch and the
 * IMAP move all call it, and a second copy of "what a thread's counters mean"
 * is exactly the drift that leaves an unread badge outliving its mail.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

/** Re-derive a thread's aggregate counters from its current messages. */
export async function rebuildThreadAggregates(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one thread's messages

	if (messages.length === 0) {
		await ctx.db.delete(threadId);
		return;
	}

	const sorted = [...messages].sort((a, b) => b.receivedAt - a.receivedAt);
	const latest = sorted[0]!;
	const oldest = sorted[sorted.length - 1]!;
	const unread = messages.filter((m) => !m.flagSeen).length;
	const hasFlagged = messages.some((m) => m.flagFlagged);
	const hasAttachments = messages.some((m) => m.hasAttachments);
	const folderRoles = new Set<string>();
	for (const m of messages) {
		const folder = await ctx.db.get(m.folderId);
		if (folder?.role) folderRoles.add(folder.role);
	}
	const labelIds = new Set<Id<'mailLabels'>>();
	for (const m of messages) {
		for (const l of m.labelIds) labelIds.add(l);
	}
	const participants = new Set<string>();
	for (const m of messages) {
		participants.add(m.fromAddress);
		for (const a of m.toAddresses) participants.add(a);
	}

	await ctx.db.patch(threadId, {
		messageCount: messages.length,
		unreadCount: unread,
		hasFlagged,
		hasAttachments,
		lastMessageAt: latest.receivedAt,
		firstMessageAt: oldest.receivedAt,
		latestSnippet: latest.snippet,
		latestFromAddress: latest.fromAddress,
		latestSubject: latest.subject,
		latestMessageId: latest._id,
		folderRoles: Array.from(folderRoles),
		labelIds: Array.from(labelIds),
		participants: Array.from(participants),
		updatedAt: Date.now(),
	});
}
