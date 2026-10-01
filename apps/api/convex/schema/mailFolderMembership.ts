import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * The IMAP sequence map's own copy of which UIDs each folder holds
 * (`mail/folderMembership.ts`). Without it, every IMAP command that takes a
 * message set lists the whole folder through `mailMessages` (full documents,
 * attachment metadata included) to learn the folder's UIDs.
 *
 * `mailFolderUidBlocks` holds the UIDs themselves, a few hundred per row, so a
 * 100k-message folder is a few hundred small rows instead of 100k message
 * documents. `mailFolderMembership` is one row per maintained folder: whether
 * its blocks are complete, how far the backfill got, and a revision that every
 * membership change bumps in the same transaction as the message write. The
 * IMAP server keys its cached sequence maps by that revision, so it only reuses
 * a map while nothing has been added to or removed from the folder.
 *
 * Derived data: rebuilt by `migrations/0054_backfill_folder_membership`, and
 * deleted with the folder (or swept with the workspace) like the counters.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailFolderMembershipTables = {
	mailFolderMembership: defineTable({
		folderId: v.id('mailFolders'),
		/** The blocks hold exactly the folder's UIDs and readers may use them. */
		isReady: v.boolean(),
		/** Bumped by every insert, move and delete in the folder. Never by the backfill. */
		revision: v.number(),
		/** Backfill page cursor over `by_folder_and_uid`; null before page 1 and once ready. */
		cursor: v.union(v.string(), v.null()),
		/**
		 * `(uid, _creationTime)` of the last message the backfill added. A write at
		 * or before it updates the blocks; a write past it is left to the walk.
		 */
		watermark: v.optional(v.object({ key: v.number(), creationTime: v.number() })),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		updatedAt: v.number(),
	}).index('by_folder', ['folderId']),

	mailFolderUidBlocks: defineTable({
		folderId: v.id('mailFolders'),
		/**
		 * Lower bound of the block: every UID in it is at least this, and below the
		 * next block's bound. Not necessarily `uids[0]`, which may have been removed.
		 */
		firstUid: v.number(),
		/** Ascending. A UID two messages share (legacy data) appears twice. */
		uids: v.array(v.number()),
	}).index('by_folder_and_first_uid', ['folderId', 'firstUid']),
};
