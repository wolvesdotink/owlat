/**
 * Custom folder CRUD for personal mailboxes.
 *
 * System folders (inbox/sent/drafts/trash/spam/archive) are auto-provisioned
 * in mailMailbox.create — they're not managed here. This module is for
 * USER-created folders (e.g. "Receipts", "Travel").
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { loadOwnedMailbox } from './permissions';
import {
	throwAlreadyExists,
	throwForbidden,
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';

/**
 * Bump a folder's unread counter, clamped at 0. Shared by the snooze
 * adjustments and the seen-flag flips so the clamp logic can't drift.
 */
export async function adjustFolderUnseen(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>,
	delta: number
): Promise<void> {
	const folder = await ctx.db.get(folderId);
	if (!folder) return;
	await ctx.db.patch(folderId, {
		unseenCount: Math.max(0, folder.unseenCount + delta),
		updatedAt: Date.now(),
	});
}

/** Per-batch cap for the scheduled folder-deletion message relocation. */
const FOLDER_RELOCATE_BATCH = 256;

const RESERVED_NAMES = new Set(['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive']);

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		parentId: v.optional(v.id('mailFolders')),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const trimmed = args.name.trim();
		if (!trimmed) throwInvalidInput('Folder name required');
		if (RESERVED_NAMES.has(trimmed)) throwInvalidInput('Reserved system folder name');

		const conflict = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_name', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('name', trimmed)
			)
			.first();
		if (conflict) throwAlreadyExists(`Folder "${trimmed}" already exists`);

		if (args.parentId) {
			const parent = await ctx.db.get(args.parentId);
			if (!parent || parent.mailboxId !== args.mailboxId) {
				throwInvalidInput('Invalid parent folder');
			}
		}

		const now = Date.now();
		return ctx.db.insert('mailFolders', {
			mailboxId: args.mailboxId,
			name: trimmed,
			role: undefined,
			parentId: args.parentId,
			uidValidity: now,
			uidNext: 1,
			highestModseq: 1,
			totalCount: 0,
			unseenCount: 0,
			subscribed: true,
			createdAt: now,
			updatedAt: now,
		});
	},
});

export const rename = authedMutation({
	args: { folderId: v.id('mailFolders'), name: v.string() },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) throwNotFound('Folder');
		if (folder.role) throwInvalidState('System folders cannot be renamed');
		const owned = await loadOwnedMailbox(ctx, folder.mailboxId);
		if (!owned.ok) throwForbidden('Folder not accessible');

		const trimmed = args.name.trim();
		if (!trimmed) throwInvalidInput('Folder name required');
		if (RESERVED_NAMES.has(trimmed)) throwInvalidInput('Reserved system folder name');

		const conflict = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_name', (q) =>
				q.eq('mailboxId', folder.mailboxId).eq('name', trimmed)
			)
			.first();
		if (conflict && conflict._id !== folder._id) {
			throwAlreadyExists(`Folder "${trimmed}" already exists`);
		}

		await ctx.db.patch(args.folderId, { name: trimmed, updatedAt: Date.now() });
	},
});

export const remove = authedMutation({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return;
		if (folder.role) throwInvalidState('System folders cannot be deleted');
		const owned = await loadOwnedMailbox(ctx, folder.mailboxId);
		if (!owned.ok) throwForbidden('Folder not accessible');

		// Move any messages to INBOX before deleting. Relocation runs in scheduled
		// batches (see relocateAndDeleteFolder) rather than collecting + re-patching
		// the whole folder in one mutation, which exceeded the per-transaction
		// read/write budget on a large folder.
		const inbox = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', folder.mailboxId).eq('role', 'inbox')
			)
			.first();
		if (!inbox) throwInvalidState('INBOX missing — cannot relocate messages');

		await ctx.scheduler.runAfter(0, internal.mail.folders.relocateAndDeleteFolder, {
			folderId: args.folderId,
			inboxId: inbox._id,
		});
	},
});

/**
 * Scheduled folder-deletion cascade: relocate one bounded page of the folder's
 * messages to INBOX, rescheduling until drained, then delete the folder row.
 *
 * Allocates a contiguous UID block on INBOX per batch from RUNNING locals and
 * writes INBOX once at the end of the batch. The previous inline loop re-read
 * `inbox.uidNext` from a STALE in-memory snapshot every iteration, so every
 * relocated message got the SAME uid + modseq — a correctness bug, not just a
 * perf one.
 */
export const relocateAndDeleteFolder = internalMutation({
	args: { folderId: v.id('mailFolders'), inboxId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', args.folderId))
			.take(FOLDER_RELOCATE_BATCH);

		if (batch.length > 0) {
			const inbox = await ctx.db.get(args.inboxId);
			if (!inbox) return; // INBOX vanished — abort rather than orphan UIDs
			const now = Date.now();
			let uidNext = inbox.uidNext;
			let modseq = inbox.highestModseq;
			let totalDelta = 0;
			let unseenDelta = 0;
			for (const m of batch) {
				modseq += 1;
				await ctx.db.patch(m._id, {
					folderId: args.inboxId,
					uid: uidNext,
					modseq,
					updatedAt: now,
				});
				uidNext += 1;
				totalDelta += 1;
				unseenDelta += m.flagSeen ? 0 : 1;
			}
			// One INBOX patch per batch with the final running values.
			await ctx.db.patch(args.inboxId, {
				uidNext,
				highestModseq: modseq,
				totalCount: inbox.totalCount + totalDelta,
				unseenCount: inbox.unseenCount + unseenDelta,
				updatedAt: now,
			});
		}

		if (batch.length === FOLDER_RELOCATE_BATCH) {
			await ctx.scheduler.runAfter(0, internal.mail.folders.relocateAndDeleteFolder, {
				folderId: args.folderId,
				inboxId: args.inboxId,
			});
		} else {
			// Get-before-delete: a concurrent double-remove schedules two relocation
			// chains; the second reaching this branch would otherwise delete an
			// already-deleted folder and throw from the scheduled function.
			const folder = await ctx.db.get(args.folderId);
			if (folder) await ctx.db.delete(args.folderId);
		}
	},
});

export const setSubscribed = authedMutation({
	args: { folderId: v.id('mailFolders'), subscribed: v.boolean() },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return;
		const owned = await loadOwnedMailbox(ctx, folder.mailboxId);
		if (!owned.ok) return;
		await ctx.db.patch(args.folderId, {
			subscribed: args.subscribed,
			updatedAt: Date.now(),
		});
	},
});

// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect();
	},
});
