/**
 * Flag writes for a batch of messages: the per-message patch, the containing
 * folders' IMAP counters, and the thread deltas (plan 3.3).
 *
 * Every flag change gives the message a fresh `modseq` from its folder so IMAP
 * CONDSTORE clients see it, and moves the folder's `unseenCount` when the seen
 * flag flips. Done one message at a time that was two folder reads and two
 * folder patches per message; {@link FolderFlagWrites} keeps each folder in
 * memory and writes it once, with the same modseq sequence and the same
 * clamped counter the one-at-a-time writes produced.
 *
 * Not a Convex function; shared by `mail/messageActions.ts` and the provider
 * pull in `mail/external/remoteState.ts`.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { isMessageSnoozed } from '../lib/mailSnooze';
import {
	applyThreadFlagDelta,
	recordThreadFlagChange,
	type ThreadFlagDeltas,
} from './threadAggregates';
import { recordMessageCounters } from './messageCounters';
import { changedRemoteFlags, recordRemoteChanges, type RemoteChange } from './external/remoteOps';

export type Flag = 'seen' | 'flagged' | 'answered' | 'deleted';

type FolderEntry = { doc: Doc<'mailFolders'>; modseq: number; unseen: number };

/** Folder counters for one mutation's flag writes: one read and one patch per folder. */
export class FolderFlagWrites {
	private readonly folders = new Map<Id<'mailFolders'>, FolderEntry>();

	constructor(private readonly ctx: MutationCtx) {}

	/** The next modseq for a change in this folder, or null when the folder is gone. */
	async nextModseq(folderId: Id<'mailFolders'>): Promise<number | null> {
		let entry = this.folders.get(folderId);
		if (!entry) {
			const doc = await this.ctx.db.get(folderId);
			if (!doc) return null;
			entry = { doc, modseq: doc.highestModseq, unseen: doc.unseenCount };
			this.folders.set(folderId, entry);
		}
		entry.modseq += 1;
		return entry.modseq;
	}

	/** Shift `unseenCount`, clamped at zero per step. Call after {@link nextModseq}. */
	adjustUnseen(folderId: Id<'mailFolders'>, delta: number): void {
		const entry = this.folders.get(folderId);
		if (entry) entry.unseen = Math.max(0, entry.unseen + delta);
	}

	async flush(): Promise<void> {
		for (const [folderId, entry] of this.folders) {
			await this.ctx.db.patch(folderId, {
				highestModseq: entry.modseq,
				...(entry.unseen !== entry.doc.unseenCount ? { unseenCount: entry.unseen } : {}),
				updatedAt: Date.now(),
			});
		}
		this.folders.clear();
	}
}

/**
 * Patch one message's flags, queue its folder counter changes on `folders` and
 * its thread's change on `threads`. Returns what an external mailbox's provider
 * has to be told, for the caller to record once per batch (a change that came
 * FROM the provider ignores it), or null (and writes nothing) when the
 * message's folder is gone.
 */
export async function writeMessageFlags(
	ctx: MutationCtx,
	folders: FolderFlagWrites,
	threads: ThreadFlagDeltas,
	message: Doc<'mailMessages'>,
	flagDeltas: Partial<Record<Flag, boolean>>
): Promise<RemoteChange | null> {
	const modseq = await folders.nextModseq(message.folderId);
	if (modseq === null) return null;

	const patch: Partial<Doc<'mailMessages'>> = { modseq, updatedAt: Date.now() };
	if (flagDeltas.seen !== undefined) patch.flagSeen = flagDeltas.seen;
	if (flagDeltas.flagged !== undefined) patch.flagFlagged = flagDeltas.flagged;
	if (flagDeltas.answered !== undefined) patch.flagAnswered = flagDeltas.answered;
	if (flagDeltas.deleted !== undefined) patch.flagDeleted = flagDeltas.deleted;
	await ctx.db.patch(message._id, patch);
	await recordMessageCounters(ctx, message, { ...message, ...patch });

	// folder.unseenCount counts unread AND not-snoozed messages (snooze.ts
	// adjusts it when the snooze flag flips). A snoozed message isn't counted,
	// so a seen-flip on it must NOT touch the counter.
	if (
		flagDeltas.seen !== undefined &&
		flagDeltas.seen !== message.flagSeen &&
		!isMessageSnoozed(message, Date.now())
	) {
		folders.adjustUnseen(message.folderId, flagDeltas.seen ? -1 : 1);
	}
	recordThreadFlagChange(threads, message.threadId, message, {
		flagSeen: patch.flagSeen ?? message.flagSeen,
		flagFlagged: patch.flagFlagged ?? message.flagFlagged,
	});
	return { kind: 'flags', message, flags: changedRemoteFlags(message, flagDeltas) };
}

/**
 * {@link writeMessageFlags} for one message on its own, with the folder written
 * straight away. For the provider pull (`external/remoteState.ts`), which
 * rebuilds the touched threads itself afterwards.
 */
export async function applyFlagDelta(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	flagDeltas: Partial<Record<Flag, boolean>>
): Promise<RemoteChange | null> {
	const folders = new FolderFlagWrites(ctx);
	const change = await writeMessageFlags(ctx, folders, new Map(), message, flagDeltas);
	await folders.flush();
	return change;
}

/** Most rows one mark-thread-read transaction flips; the rest go to a continuation. */
export const MARK_THREAD_READ_BATCH = 200;

/**
 * Flip the seen flag on up to {@link MARK_THREAD_READ_BATCH} of a thread's
 * messages that still have the other value, found through `by_thread_and_seen`
 * so already-read messages (and their bodies) are never read. Returns
 * `more: true` when a full batch was written and more rows may be left.
 *
 * `ceiling` bounds a continuation to the rows that existed when the user asked
 * (see {@link newestThreadMessageCreation}): a reply that lands between two
 * batches of a long thread stays unread, and the thread count is healed
 * outright only when no such newer row disagrees. The first batch runs in the
 * user's own transaction and needs none.
 */
export async function markThreadSeenBatch(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	seen: boolean,
	ceiling?: number
): Promise<{ more: boolean }> {
	const flips = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_seen', (q) => {
			const rows = q.eq('threadId', threadId).eq('flagSeen', !seen);
			return ceiling === undefined ? rows : rows.lte('_creationTime', ceiling);
		})
		.take(MARK_THREAD_READ_BATCH);

	const folders = new FolderFlagWrites(ctx);
	const threads: ThreadFlagDeltas = new Map();
	const remote: RemoteChange[] = [];
	for (const message of flips) {
		const change = await writeMessageFlags(ctx, folders, threads, message, { seen });
		if (change) remote.push(change);
	}
	await folders.flush();
	const written = remote.length;

	const more = flips.length === MARK_THREAD_READ_BATCH && written > 0;
	const delta = threads.get(threadId) ?? { unread: 0, flagged: false, unflagged: false };
	// Every row that disagreed was flipped: the thread is now all-read or
	// all-unread, so the count is known outright (and a stale one heals).
	const settled =
		!more &&
		written === flips.length &&
		(ceiling === undefined ||
			(await ctx.db
				.query('mailMessages')
				.withIndex('by_thread_and_seen', (q) =>
					q.eq('threadId', threadId).eq('flagSeen', !seen).gt('_creationTime', ceiling)
				)
				.first()) === null);
	await applyThreadFlagDelta(ctx, threadId, delta, settled ? { allSeen: seen } : undefined);
	await recordRemoteChanges(ctx, remote);
	return { more };
}

/**
 * Creation time of the thread's newest message: the `ceiling` a mark-thread-read
 * continuation carries, so it flips only what the user saw when they asked.
 */
export async function newestThreadMessageCreation(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<number> {
	const newest = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();
	return newest?._creationTime ?? 0;
}
