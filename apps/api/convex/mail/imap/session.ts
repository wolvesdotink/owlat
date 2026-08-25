/**
 * IMAP session commands — LIST / SELECT / IDLE (see mail/imap/ for the module
 * overview). The folder-shaped reads the IMAP server issues to open a session
 * and to notice that something changed, kept together because they all answer
 * from one `mailFolders` row.
 */

import { v } from 'convex/values';
import { internalQuery } from '../../_generated/server';

/** LIST output for a single mailbox account. Includes role + counts so the
 *  IMAP server can emit `* LIST (\Inbox \HasNoChildren) "/" "INBOX"` etc. */
export const listFolders = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const folders = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's folders
		return folders.map((f) => ({
			_id: f._id,
			name: f.name,
			role: f.role,
			parentId: f.parentId,
			uidValidity: f.uidValidity,
			uidNext: f.uidNext,
			highestModseq: f.highestModseq,
			totalCount: f.totalCount,
			unseenCount: f.unseenCount,
			subscribed: f.subscribed,
		}));
	},
});

/** SELECT response — returns folder metadata and the message count
 *  required for `* {n} EXISTS / RECENT / OK [UNSEEN]`. */
export const selectFolder = internalQuery({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return null;
		// First-unseen is required for `* OK [UNSEEN]`: the smallest UID with
		// flagSeen=false. The by_folder_and_seen index orders unseen messages by
		// uid, so this is an O(1) `.first()` instead of collecting + JS-sorting the
		// whole folder on every SELECT (a latency-sensitive, frequently-repeated
		// IMAP command).
		const firstUnseen = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_seen', (q) => q.eq('folderId', args.folderId).eq('flagSeen', false))
			.order('asc')
			.first();
		// RFC 3501 §7.1: `* OK [UNSEEN n]` reports the *message sequence
		// number* of the first unseen message, not its UID. The sequence
		// number is the 1-based position by UID ascending, i.e. one more
		// than the count of messages with a smaller UID.
		let firstUnseenSeq: number | undefined;
		if (firstUnseen) {
			const earlier = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) =>
					q.eq('folderId', args.folderId).lt('uid', firstUnseen.uid)
				)
				.collect(); // bounded: one folder's messages in a UID range
			firstUnseenSeq = earlier.length + 1;
		}
		return {
			folder: {
				_id: folder._id,
				name: folder.name,
				role: folder.role,
				uidValidity: folder.uidValidity,
				uidNext: folder.uidNext,
				highestModseq: folder.highestModseq,
				totalCount: folder.totalCount,
				unseenCount: folder.unseenCount,
			},
			firstUnseenUid: firstUnseen?.uid,
			firstUnseenSeq,
		};
	},
});

/** Resolve the system folder for an account by its IMAP role (\Sent \Trash …) */
export const resolveSpecialFolder = internalQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		role: v.union(
			v.literal('inbox'),
			v.literal('sent'),
			v.literal('drafts'),
			v.literal('trash'),
			v.literal('spam'),
			v.literal('archive')
		),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', args.role)
			)
			.first();
		return folder ? { _id: folder._id, name: folder.name } : null;
	},
});

/** Per-folder highest modseq, used by IDLE to detect changes since last poll. */
export const peekFolderModseq = internalQuery({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return null;
		return {
			highestModseq: folder.highestModseq,
			uidNext: folder.uidNext,
			totalCount: folder.totalCount,
			unseenCount: folder.unseenCount,
		};
	},
});
