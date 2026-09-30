/**
 * Thread aggregate rebuild — the one place a `mailThreads` row is re-derived
 * from the messages it actually contains — plus the incremental path flag
 * changes take instead (plan 3.3).
 *
 * Split out of `mail/messageActions.ts` (size cap) rather than duplicated: the
 * triage mutations, the retroactive filter sweep, the follow-up watch and the
 * IMAP move all call it, and a second copy of "what a thread's counters mean"
 * is exactly the drift that leaves an unread badge outliving its mail.
 */

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { batchGet } from '../_utils/batchLoader';
import { deleteMailThreadCatchUps } from './ai/catchUpStore';

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

/**
 * Re-derive a thread's aggregate counters from its current messages.
 *
 * Reads every message of the thread, so it is for the operations that change
 * WHICH messages a thread holds or where they sit: move, archive, trash, purge,
 * IMAP append, the filter sweep. A flag change (read, star) only shifts
 * `unreadCount` / `hasFlagged` and goes through {@link applyThreadFlagDeltas}.
 */
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
		// Answer mode catch-up cards retell the purged mail: they go with the thread.
		await deleteMailThreadCatchUps(ctx, threadId);
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
		latestSnoozedUntil: latest.snoozedUntil ?? null,
		folderRoles: Array.from(folderRoles),
		labelIds: Array.from(labelIds),
		participants,
		updatedAt: Date.now(),
	});
}

/** Flag state of one message before or after a change. */
type FlagState = { flagSeen: boolean; flagFlagged: boolean };

/** What one mutation's flag writes did to a thread's `unreadCount` / `hasFlagged`. */
type ThreadFlagDelta = { unread: number; flagged: boolean; unflagged: boolean };

/** Per-thread flag deltas collected across one mutation, applied once at the end. */
export type ThreadFlagDeltas = Map<Id<'mailThreads'>, ThreadFlagDelta>;

/** Record one message's flag change against its thread. A no-op change records nothing. */
export function recordThreadFlagChange(
	deltas: ThreadFlagDeltas,
	threadId: Id<'mailThreads'>,
	before: FlagState,
	after: FlagState
): void {
	const seenChanged = before.flagSeen !== after.flagSeen;
	const flaggedChanged = before.flagFlagged !== after.flagFlagged;
	if (!seenChanged && !flaggedChanged) return;
	const delta = deltas.get(threadId) ?? { unread: 0, flagged: false, unflagged: false };
	if (seenChanged) delta.unread += after.flagSeen ? -1 : 1;
	if (flaggedChanged) {
		if (after.flagFlagged) delta.flagged = true;
		else delta.unflagged = true;
	}
	deltas.set(threadId, delta);
}

/**
 * Apply collected flag deltas to their threads: one thread read and at most one
 * patch each. `hasFlagged` needs a message read only on an unflag that nothing
 * in the same batch re-flagged, and then it is a single indexed `first()`.
 * Call AFTER the message patches, so that lookup sees them.
 */
export async function applyThreadFlagDeltas(
	ctx: MutationCtx,
	deltas: ThreadFlagDeltas
): Promise<void> {
	for (const [threadId, delta] of deltas) {
		await applyThreadFlagDelta(ctx, threadId, delta);
	}
}

/**
 * One thread's delta. `settled.allSeen` replaces the unread arithmetic when the
 * caller knows every message now has that seen value (a mark-thread-read that
 * flipped every row that disagreed).
 */
export async function applyThreadFlagDelta(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	delta: ThreadFlagDelta,
	settled?: { allSeen: boolean }
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const patch: { unreadCount?: number; hasFlagged?: boolean } = {};

	const unread = settled
		? settled.allSeen
			? 0
			: thread.messageCount
		: Math.min(thread.messageCount, Math.max(0, thread.unreadCount + delta.unread));
	if (unread !== thread.unreadCount) patch.unreadCount = unread;

	if (delta.flagged) {
		if (!thread.hasFlagged) patch.hasFlagged = true;
	} else if (delta.unflagged && thread.hasFlagged) {
		const stillFlagged = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_and_flagged', (q) => q.eq('threadId', threadId).eq('flagFlagged', true))
			.first();
		if (!stillFlagged) patch.hasFlagged = false;
	}

	// An unchanged thread is not written, so its subscribers do not re-run.
	if (patch.unreadCount === undefined && patch.hasFlagged === undefined) return;
	await ctx.db.patch(threadId, { ...patch, updatedAt: Date.now() });
}
