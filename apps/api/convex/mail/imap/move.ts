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

/**
 * COPY — clones a message into another folder of the SAME mailbox.
 * Storage blob is shared (just a new mailMessages row pointing at it).
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

		for (const id of args.messageIds) {
			const m = await ctx.db.get(id);
			if (!m || m.folderId !== source._id) continue;

			const newUid = uidNext++;
			const newModseq = modseq++;
			totalDelta += 1;
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
			await ctx.db.insert('mailMessages', {
				...rest,
				folderId: target._id,
				uid: newUid,
				modseq: newModseq,
				createdAt: now,
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
 * Returns the deleted message-sequence numbers (1-based, ordered by
 * UID asc) so the IMAP server can emit `* {seq} EXPUNGE` per row.
 */
export const expungeFolder = internalMutation({
	args: {
		folderId: v.id('mailFolders'),
		uidSet: v.optional(v.array(v.number())),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return { sequenceNumbers: [], modseq: 0 };

		const allMessages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', args.folderId))
			.collect(); // bounded: one folder's messages in a UID range
		allMessages.sort((a, b) => a.uid - b.uid);

		const uidFilter = args.uidSet ? new Set(args.uidSet) : null;
		const expungedSequences: number[] = [];
		const touchedThreads = new Set<Id<'mailThreads'>>();
		let totalRemoved = 0;
		let unseenRemoved = 0;
		let bytesRemoved = 0;

		// Iterate from the END so sequence numbers stay stable as we delete
		for (let i = allMessages.length - 1; i >= 0; i--) {
			const m = allMessages[i];
			if (!m || !m.flagDeleted) continue;
			if (uidFilter && !uidFilter.has(m.uid)) continue;

			expungedSequences.push(i + 1);
			totalRemoved += 1;
			if (!m.flagSeen) unseenRemoved += 1;
			bytesRemoved += m.rawSize;
			touchedThreads.add(m.threadId);

			try {
				await ctx.storage.delete(m.rawStorageId);
			} catch {
				/* storage may already be gone */
			}
			await ctx.db.delete(m._id);
		}

		// Re-derive thread aggregates (incl. latestMessageId) for any thread that
		// lost a message — otherwise an expunged latest leaves a dangling pointer.
		for (const tid of touchedThreads) {
			await rebuildThreadAggregates(ctx, tid);
		}

		const newModseq = await bumpFolderModseq(ctx, args.folderId);
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

		// Return ascending so IMAP server can iterate naturally (the array
		// is currently descending because we walked in reverse).
		expungedSequences.reverse();
		return { sequenceNumbers: expungedSequences, modseq: newModseq };
	},
});
