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
import { batchGet } from '../_utils/batchLoader';

/**
 * Most addresses a thread's `participants` array holds. Every message adds its
 * From, To and Cc, so a long thread on a large distribution list would otherwise
 * grow toward Convex's 8192-element array limit, and the delivery mutation would
 * throw instead of inserting the message.
 */
export const THREAD_PARTICIPANT_CAP = 500;

/**
 * Merge addresses into a thread participant list: first-seen order, duplicates
 * and empty entries dropped, at most `THREAD_PARTICIPANT_CAP` entries. `pinned`
 * (the mailbox's own address) is always kept, even when the cap is reached.
 */
export function mergeThreadParticipants(addresses: Iterable<string>, pinned?: string): string[] {
	const out = new Set<string>();
	for (const address of addresses) {
		if (!address || out.has(address)) continue;
		const room =
			pinned === undefined || address === pinned || out.has(pinned)
				? THREAD_PARTICIPANT_CAP
				: THREAD_PARTICIPANT_CAP - 1;
		if (out.size < room) out.add(address);
	}
	if (pinned) out.add(pinned);
	return Array.from(out);
}

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
	// One thread's messages sit in a handful of folders; `batchGet` dedupes the
	// ids and reads what is left in parallel.
	const folders = await batchGet(
		ctx,
		messages.map((m) => m.folderId)
	);
	for (const m of messages) {
		const role = folders.get(m.folderId)?.role;
		if (role) folderRoles.add(role);
	}
	const labelIds = new Set<Id<'mailLabels'>>();
	for (const m of messages) {
		for (const l of m.labelIds) labelIds.add(l);
	}
	const participants = mergeThreadParticipants(
		messages.flatMap((m) => [m.fromAddress, ...m.toAddresses, ...m.ccAddresses])
	);

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
		participants,
		updatedAt: Date.now(),
	});
}
