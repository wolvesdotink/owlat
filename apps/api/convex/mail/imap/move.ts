/**
 * IMAP COPY / MOVE / EXPUNGE — the commands that relocate or remove rows
 * (see mail/imap/ for the module overview).
 *
 * Every mutation here bumps the folder's `highestModseq` so CONDSTORE/QRESYNC
 * clients can resync incrementally; UID / modseq allocation stays behind these
 * functions so the IMAP server never needs to know the storage shape.
 */

import { v } from 'convex/values';
import { internalMutation } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { rebuildThreadAggregates } from '../messageActions';
import { bumpFolderModseq } from '../folders';
import { indexMessageAttachments, removeMessageAttachments } from '../attachmentIndex';
import { deleteMessageRowAndBlobs } from '../messagePurge';

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
				await ctx.db.patch(mailbox._id, {
					usedBytes: mailbox.usedBytes + bytesAdded,
					usageRevision: (mailbox.usageRevision ?? 0) + 1,
					updatedAt: now,
				});
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
			await ctx.db.patch(source._id, {
				totalCount: Math.max(0, source.totalCount - sourceTotalDelta),
				unseenCount: Math.max(0, source.unseenCount - sourceUnseenDelta),
				highestModseq: source.highestModseq + 1,
				updatedAt: now,
			});
		}

		return {
			uidValidity: target.uidValidity,
			pairs,
		};
	},
});

/**
 * EXPUNGE — permanently delete all `\Deleted`-flagged messages in a
 * folder. UID EXPUNGE narrows to a UID set.
 *
 * Returns one bounded page of deleted message-sequence numbers (1-based) plus
 * a keyset cursor so the IMAP server can drain the folder without placing every
 * row in one Convex transaction.
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
		const page = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => {
				const folderRange = q.eq('folderId', args.folderId);
				return args.beforeUid === undefined ? folderRange : folderRange.lt('uid', args.beforeUid);
			})
			.order('desc')
			.take(batchSize);
		let sequenceNumber = args.nextSequenceNumber ?? folder.totalCount;

		const uidFilter = args.uidSet ? new Set(args.uidSet) : null;
		const expungedSequences: number[] = [];
		const touchedThreads = new Set<Id<'mailThreads'>>();
		let totalRemoved = 0;
		let unseenRemoved = 0;
		let bytesRemoved = 0;

		for (const m of page) {
			const currentSequence = sequenceNumber--;
			if (!m.flagDeleted) continue;
			if (uidFilter && !uidFilter.has(m.uid)) continue;

			expungedSequences.push(currentSequence);
			totalRemoved += 1;
			if (!m.flagSeen) unseenRemoved += 1;
			bytesRemoved += m.rawSize;
			touchedThreads.add(m.threadId);

			await removeMessageAttachments(ctx, m._id);
			// Refcount-aware: a COPY sibling in another folder of this mailbox may
			// still point at the same blobs (see mail/messagePurge.ts). This also
			// frees the body blobs, which the hand-rolled delete here never did.
			await deleteMessageRowAndBlobs(ctx, m);
		}

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
				await ctx.db.patch(mailbox._id, {
					usedBytes: Math.max(0, mailbox.usedBytes - bytesRemoved),
					updatedAt: Date.now(),
				});
			}
		}

		const done = page.length < batchSize;
		return {
			// This page was walked in descending UID/sequence order. The IMAP bridge
			// aggregates pages in that same order and can emit the values directly.
			sequenceNumbers: expungedSequences,
			modseq: newModseq,
			done,
			beforeUid: done ? undefined : page[page.length - 1]!.uid,
			nextSequenceNumber: done ? undefined : sequenceNumber,
		};
	},
});
