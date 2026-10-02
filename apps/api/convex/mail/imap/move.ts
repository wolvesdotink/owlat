/**
 * IMAP COPY / MOVE / EXPUNGE — the commands that relocate or remove rows
 * (see mail/imap/ for the module overview).
 *
 * Every mutation here bumps the folder's `highestModseq` so CONDSTORE/QRESYNC
 * clients can resync incrementally; UID / modseq allocation stays behind these
 * functions so the IMAP server never needs to know the storage shape.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../lib/writeFence';
import type { Id } from '../../_generated/dataModel';
import { rebuildThreadAggregates } from '../messageActions';
import { bumpFolderModseq } from '../folders';
import { indexMessageAttachments, removeMessageAttachments } from '../attachmentIndex';
import { deleteMessageRowAndBlobs } from '../messagePurge';
import { applyMailboxUsageDelta } from '../mailboxUsage';
import { recordMessageCounters } from '../messageCounters';
import { recordFolderMembership } from '../folderMembership';
import { copyMessageBody } from '../../lib/messageBodyStore';
import { recordRemoteChanges, type RemoteChange } from '../external/remoteOps';

/**
 * COPY — clones a message into another folder of the SAME mailbox.
 * Storage blob is shared (just a new mailMessages row pointing at it), and is
 * freed only with the LAST row referencing it — see `deleteMessageRowAndBlobs`
 * in `mail/messagePurge.ts`.
 * Returns the (sourceUid, targetUid) pairs for `COPYUID` response.
 */
export const copyMessages = internalMutation({
	args: {
		sourceFolderId: v.id('mailFolders'),
		targetFolderId: v.id('mailFolders'),
		messageIds: v.array(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const target = await ctx.db.get(args.targetFolderId);
		const source = await ctx.db.get(args.sourceFolderId);
		if (!target || !source) throw new Error('Folder not found');
		if (target.mailboxId !== source.mailboxId) {
			throw new Error('Cross-mailbox COPY not supported');
		}

		const pairs: Array<{ sourceUid: number; targetUid: number }> = [];
		const now = Date.now();
		let uidNext = target.uidNext;
		let modseq = target.highestModseq + 1;
		let totalDelta = 0;
		let unseenDelta = 0;
		let bytesAdded = 0;

		for (const id of args.messageIds) {
			const m = await ctx.db.get(id);
			if (!m || m.folderId !== source._id) continue;

			const newUid = uidNext++;
			const newModseq = modseq++;
			totalDelta += 1;
			bytesAdded += m.rawSize;
			if (!m.flagSeen) unseenDelta += 1;

			const {
				_id,
				_creationTime,
				folderId,
				uid,
				modseq: _ms,
				createdAt: _ca,
				updatedAt: _ua,
				...rest
			} = m;
			void _id;
			void _creationTime;
			void folderId;
			void uid;
			void _ms;
			void _ca;
			void _ua;
			const copyId = await ctx.db.insert('mailMessages', {
				...rest,
				folderId: target._id,
				uid: newUid,
				modseq: newModseq,
				createdAt: now,
				updatedAt: now,
			});
			await copyMessageBody(ctx.db, m._id, copyId);
			await recordMessageCounters(ctx, null, { ...rest, folderId: target._id });
			await recordFolderMembership(ctx, null, { folderId: target._id, uid: newUid });
			// The copy is its own message row, so it gets its own junction rows —
			// otherwise a COPY into a folder would silently drop the copy's files
			// out of the Files view and out of `filename:`.
			await indexMessageAttachments(ctx, {
				_id: copyId,
				mailboxId: rest.mailboxId,
				folderId: target._id,
				fromAddress: rest.fromAddress,
				receivedAt: rest.receivedAt,
				attachments: rest.attachments,
			});
			pairs.push({ sourceUid: m.uid, targetUid: newUid });
		}

		if (pairs.length > 0) {
			await ctx.db.patch(target._id, {
				uidNext,
				highestModseq: modseq - 1,
				totalCount: target.totalCount + totalDelta,
				unseenCount: target.unseenCount + unseenDelta,
				updatedAt: now,
			});
			// `usedBytes` counts PER ROW, not per distinct blob — the same thing
			// IMAP QUOTA (RFC 2087) reports, and the only accounting that can
			// balance: every delete path decrements one row's `rawSize`
			// unconditionally (`mail/messagePurge.ts`, `expungeFolder` below), so a
			// COPY that added nothing made a copy-then-expunge cycle drive the
			// counter down forever. The blob itself is shared and refcounted
			// separately; this counter answers "how much mail does this mailbox
			// hold", which is what the MTA's over-quota recipient gate asks.
			const mailbox = await ctx.db.get(target.mailboxId);
			if (mailbox) {
				await applyMailboxUsageDelta(ctx, mailbox, bytesAdded, now);
			}
		}

		return {
			uidValidity: target.uidValidity,
			pairs,
		};
	},
});

/**
 * MOVE (RFC 6851) — atomic relocation. Same UID/modseq allocation as
 * COPY but the source row is removed instead of duplicated.
 */
export const moveMessages = internalMutation({
	args: {
		sourceFolderId: v.id('mailFolders'),
		targetFolderId: v.id('mailFolders'),
		messageIds: v.array(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const target = await ctx.db.get(args.targetFolderId);
		const source = await ctx.db.get(args.sourceFolderId);
		if (!target || !source) throw new Error('Folder not found');
		if (target.mailboxId !== source.mailboxId) {
			throw new Error('Cross-mailbox MOVE not supported');
		}

		const pairs: Array<{ sourceUid: number; targetUid: number }> = [];
		const now = Date.now();
		let uidNext = target.uidNext;
		let modseq = target.highestModseq + 1;
		let totalDelta = 0;
		let unseenDelta = 0;
		let sourceTotalDelta = 0;
		let sourceUnseenDelta = 0;
		const remote: RemoteChange[] = [];

		for (const id of args.messageIds) {
			const m = await ctx.db.get(id);
			if (!m || m.folderId !== source._id) continue;

			const newUid = uidNext++;
			const newModseq = modseq++;
			totalDelta += 1;
			sourceTotalDelta += 1;
			if (!m.flagSeen) {
				unseenDelta += 1;
				sourceUnseenDelta += 1;
			}

			await ctx.db.patch(id, {
				folderId: target._id,
				uid: newUid,
				modseq: newModseq,
				updatedAt: now,
			});
			await recordMessageCounters(ctx, m, { ...m, folderId: target._id });
			await recordFolderMembership(ctx, m, { ...m, folderId: target._id, uid: newUid });
			pairs.push({ sourceUid: m.uid, targetUid: newUid });
			remote.push({
				kind: 'move',
				message: m,
				sourceFolderId: source._id,
				targetFolderId: target._id,
			});
		}

		if (pairs.length > 0) {
			await ctx.db.patch(target._id, {
				uidNext,
				highestModseq: modseq - 1,
				totalCount: target.totalCount + totalDelta,
				unseenCount: target.unseenCount + unseenDelta,
				updatedAt: now,
			});
			await ctx.db.patch(source._id, {
				totalCount: Math.max(0, source.totalCount - sourceTotalDelta),
				unseenCount: Math.max(0, source.unseenCount - sourceUnseenDelta),
				highestModseq: source.highestModseq + 1,
				updatedAt: now,
			});
		}
		await recordRemoteChanges(ctx, remote);

		return {
			uidValidity: target.uidValidity,
			pairs,
		};
	},
});

/**
 * Undo a COPY the IMAP server could not finish. COPY must leave the target
 * folder as it was when it fails (RFC 3501 §6.4.7, RFC 9051 §6.4.7), and the
 * IMAP server copies a large set in several `copyMessages` calls, so when a
 * later call fails it removes the rows the earlier ones created. Only rows in
 * `targetFolderId` whose UIDs are listed are removed; UIDNEXT stays advanced,
 * which both RFCs allow.
 */
export const discardCopies = internalMutation({
	args: {
		targetFolderId: v.id('mailFolders'),
		uids: v.array(v.number()),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.targetFolderId);
		if (!folder) return { removed: 0 };

		const touchedThreads = new Set<Id<'mailThreads'>>();
		let removed = 0;
		let unseenRemoved = 0;
		let bytesRemoved = 0;
		for (const uid of args.uids) {
			const m = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folder._id).eq('uid', uid))
				.unique();
			if (!m) continue;
			removed += 1;
			if (!m.flagSeen) unseenRemoved += 1;
			bytesRemoved += m.rawSize;
			touchedThreads.add(m.threadId);
			await removeMessageAttachments(ctx, m._id);
			// Refcount-aware: the source row still points at the same blobs.
			await deleteMessageRowAndBlobs(ctx, m);
		}
		for (const tid of touchedThreads) {
			await rebuildThreadAggregates(ctx, tid);
		}

		if (removed > 0) {
			await bumpFolderModseq(ctx, folder._id);
			await ctx.db.patch(folder._id, {
				totalCount: Math.max(0, folder.totalCount - removed),
				unseenCount: Math.max(0, folder.unseenCount - unseenRemoved),
				updatedAt: Date.now(),
			});
			const mailbox = await ctx.db.get(folder.mailboxId);
			if (mailbox) {
				await applyMailboxUsageDelta(ctx, mailbox, -bytesRemoved);
			}
		}
		return { removed };
	},
});

/**
 * EXPUNGE — permanently delete all `\Deleted`-flagged messages in a
 * folder. UID EXPUNGE narrows to a UID set.
 *
 * Returns one bounded page of deleted message-sequence numbers (1-based) plus
 * a keyset cursor so the IMAP server can drain the folder without placing every
 * row in one Convex transaction.
 *
 * With a `uidSet` the walk stops at the set's lowest UID: nothing below it can
 * be expunged, and every sequence number above it is already counted. That is
 * what lets the IMAP server send a large UID set in chunks (Convex caps an
 * array argument at 8,192 elements): it sends the highest UIDs first and threads
 * the returned cursor into the call for the next, lower chunk. The cursor is
 * returned on the last page too, for that reason.
 */
export const expungeFolder = internalMutation({
	args: {
		folderId: v.id('mailFolders'),
		uidSet: v.optional(v.array(v.number())),
		beforeUid: v.optional(v.number()),
		nextSequenceNumber: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return { sequenceNumbers: [], modseq: 0, done: true };

		// Keyset-walk from the highest UID down. Sequence numbers are positions in
		// the folder view that existed when EXPUNGE started, so the caller threads
		// the next sequence alongside the UID cursor while each transaction stays
		// bounded. Descending order also keeps later sequence numbers stable as this
		// page deletes rows above them.
		const batchSize = 100;
		let lowestUid: number | undefined;
		for (const uid of args.uidSet ?? []) {
			if (lowestUid === undefined || uid < lowestUid) lowestUid = uid;
		}
		const page = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => {
				const folderRange = q.eq('folderId', args.folderId);
				const floored = lowestUid === undefined ? folderRange : folderRange.gte('uid', lowestUid);
				return args.beforeUid === undefined ? floored : floored.lt('uid', args.beforeUid);
			})
			.order('desc')
			.take(batchSize);
		let sequenceNumber = args.nextSequenceNumber ?? folder.totalCount;

		const uidFilter = args.uidSet ? new Set(args.uidSet) : null;
		const expungedSequences: number[] = [];
		const expungedUids: number[] = [];
		const touchedThreads = new Set<Id<'mailThreads'>>();
		const remote: RemoteChange[] = [];
		let totalRemoved = 0;
		let unseenRemoved = 0;
		let bytesRemoved = 0;

		for (const m of page) {
			const currentSequence = sequenceNumber--;
			if (!m.flagDeleted) continue;
			if (uidFilter && !uidFilter.has(m.uid)) continue;

			expungedSequences.push(currentSequence);
			expungedUids.push(m.uid);
			totalRemoved += 1;
			if (!m.flagSeen) unseenRemoved += 1;
			bytesRemoved += m.rawSize;
			touchedThreads.add(m.threadId);

			await removeMessageAttachments(ctx, m._id);
			// Refcount-aware: a COPY sibling in another folder of this mailbox may
			// still point at the same blobs (see mail/messagePurge.ts). This also
			// frees the body blobs, which the hand-rolled delete here never did.
			await deleteMessageRowAndBlobs(ctx, m);
			remote.push({ kind: 'delete', message: m });
		}
		await recordRemoteChanges(ctx, remote);

		// Re-derive thread aggregates (incl. latestMessageId) for any thread that
		// lost a message — otherwise an expunged latest leaves a dangling pointer.
		for (const tid of touchedThreads) {
			await rebuildThreadAggregates(ctx, tid);
		}

		const newModseq =
			totalRemoved > 0 ? await bumpFolderModseq(ctx, args.folderId) : folder.highestModseq;
		if (totalRemoved > 0) {
			await ctx.db.patch(args.folderId, {
				totalCount: Math.max(0, folder.totalCount - totalRemoved),
				unseenCount: Math.max(0, folder.unseenCount - unseenRemoved),
				updatedAt: Date.now(),
			});
			const mailbox = await ctx.db.get(folder.mailboxId);
			if (mailbox) {
				await applyMailboxUsageDelta(ctx, mailbox, -bytesRemoved);
			}
		}

		const done = page.length < batchSize;
		return {
			// This page was walked in descending UID/sequence order. A v0.6.6 IMAP
			// server emits these directly, and its `* n EXPUNGE` lines are the only
			// way its client learns of the deletions, so they stay while such a
			// server can still run against this backend (the containers update
			// after `convex deploy`). Later servers number `uids` against their
			// client's sequence view and no longer send `nextSequenceNumber`, so
			// for them these count from the folder's total and go unread.
			sequenceNumbers: expungedSequences,
			// The same messages by UID, in the same order. The IMAP server numbers
			// them against the sequence view its client holds, which can differ from
			// the folder's current order (another session's unannounced EXPUNGE).
			uids: expungedUids,
			modseq: newModseq,
			done,
			beforeUid: page.length > 0 ? page[page.length - 1]!.uid : args.beforeUid,
			nextSequenceNumber: sequenceNumber,
		};
	},
});
