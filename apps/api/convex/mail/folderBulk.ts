/**
 * Whole-folder chores: "Mark all as read" and "Empty Trash / Spam".
 *
 * Both act on a folder rather than on a selection, so neither is capped at the
 * selection's 500 ids, and both stop at the folder's highest uid when the
 * person asked: a message that arrives (or is moved in, which allocates a new
 * uid) after the click is not part of what they cleared.
 *
 * Marking read is driven by the client one bounded batch at a time, because
 * each batch hands back the ids it flipped and the client's Undo needs every
 * one of them. Emptying has no Undo, so it continues on the scheduler and
 * finishes even if the tab closes.
 */

import { v } from 'convex/values';
import { postboxMutation } from './_helpers';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { FolderFlagWrites, writeMessageFlags } from './flagWrites';
import {
	applyThreadFlagDeltas,
	rebuildThreadAggregates,
	type ThreadFlagDeltas,
} from './threadAggregates';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from './messagePurge';
import { recordRemoteChanges, type RemoteChange } from './external/remoteOps';

/**
 * Unread messages one mark-read batch reads. A flag write costs a few index
 * reads per message plus one thread delta, and a transaction may read at most
 * 4,096 index ranges, so this stays at the size the move-family calls use.
 */
export const MARK_FOLDER_READ_BATCH = 100;

/**
 * Messages one empty-folder run deletes. A purge checks blob sharing, the
 * attachment index and the thread's derived rows per message, which makes it
 * the heaviest per-row write in Postbox.
 */
export const EMPTY_FOLDER_BATCH = 50;

/** The folders "Empty now" is offered for. Emptying any other folder is a mistake. */
const EMPTYABLE_ROLES = new Set(['trash', 'spam']);

/** The highest uid the folder holds right now, or 0 when it is empty. */
async function highestUid(ctx: MutationCtx, folderId: Id<'mailFolders'>): Promise<number> {
	const top = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folderId))
		.order('desc')
		.first();
	return top?.uid ?? 0;
}

/**
 * Mark one batch of a folder's unread messages read.
 *
 * The first call omits `ceilingUid` and `afterUid`; the answer carries both for
 * the next call, and `afterUid: null` once the folder holds no more unread mail
 * up to the ceiling. Snoozed messages are skipped: they are not in the folder
 * the person is looking at, and they should come back unread.
 *
 * Read state on a team inbox is one shared truth (see `sharedUnread.test.ts`),
 * so a member clears it for everyone, exactly as select-all and `u` do.
 */
// authz: requireMailboxAccess on the folder's mailbox (member floor, the same
// one setFlags applies per message).
export const markFolderRead = postboxMutation({
	args: {
		folderId: v.id('mailFolders'),
		ceilingUid: v.optional(v.number()),
		afterUid: v.optional(v.number()),
	},
	handler: async (
		ctx,
		args,
		session
	): Promise<{
		markedIds: Id<'mailMessages'>[];
		ceilingUid: number;
		afterUid: number | null;
	}> => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) throwNotFound('Folder');
		const access = await requireMailboxAccess(ctx, folder.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('Folder not accessible');

		const ceilingUid = args.ceilingUid ?? (await highestUid(ctx, folder._id));
		const afterUid = args.afterUid ?? 0;
		const batch = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_seen', (q) =>
				q
					.eq('folderId', folder._id)
					.eq('flagSeen', false)
					.gt('uid', afterUid)
					.lte('uid', ceilingUid)
			)
			.take(MARK_FOLDER_READ_BATCH);

		const now = Date.now();
		const folders = new FolderFlagWrites(ctx);
		const threads: ThreadFlagDeltas = new Map();
		const remote: RemoteChange[] = [];
		const markedIds: Id<'mailMessages'>[] = [];
		for (const message of batch) {
			if (isMessageSnoozed(message, now)) continue;
			const change = await writeMessageFlags(ctx, folders, threads, message, { seen: true });
			if (!change) continue;
			remote.push(change);
			markedIds.push(message._id);
		}
		await folders.flush();
		await applyThreadFlagDeltas(ctx, threads);
		await recordRemoteChanges(ctx, remote);

		const last = batch[batch.length - 1];
		return {
			markedIds,
			ceilingUid,
			afterUid: batch.length === MARK_FOLDER_READ_BATCH && last ? last.uid : null,
		};
	},
});

/**
 * Delete one run of a folder's messages up to `ceilingUid`, and schedule the
 * next run while any remain. Shared by the public mutation and its
 * continuation; the caller has checked access.
 */
async function emptyFolderRun(
	ctx: MutationCtx,
	folder: Doc<'mailFolders'>,
	ceilingUid: number
): Promise<{ purged: number; more: boolean }> {
	const batch = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_uid', (q) => q.eq('folderId', folder._id).lte('uid', ceilingUid))
		.take(EMPTY_FOLDER_BATCH);

	const touchedThreads = new Set<Id<'mailThreads'>>();
	const purged: PurgedMessages = new Map();
	const remote: RemoteChange[] = [];
	for (const message of batch) {
		touchedThreads.add(await purgeMessageRow(ctx, message, purged));
		// On an external account this expunges the provider's copy too, the
		// same write-back "Delete forever" records.
		remote.push({ kind: 'delete', message });
	}
	await purgeThreadBriefsOf(ctx, purged);
	for (const threadId of touchedThreads) await rebuildThreadAggregates(ctx, threadId);
	await recordRemoteChanges(ctx, remote);

	const more = batch.length === EMPTY_FOLDER_BATCH;
	if (more) {
		await ctx.scheduler.runAfter(0, internal.mail.folderBulk.continueEmptyFolder, {
			folderId: folder._id,
			ceilingUid,
		});
	}
	return { purged: batch.length, more };
}

/**
 * Permanently delete everything in Trash or Spam.
 *
 * On a team inbox this needs the mailbox's owner role: the bin is shared, and
 * a member's "Delete forever" on a selection is as far as one member's say
 * reaches. On a personal mailbox its own user is the owner.
 */
// authz: requireMailboxAccess(owner) on the folder's mailbox.
export const emptyFolder = postboxMutation({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args, session): Promise<{ purged: number; more: boolean }> => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) throwNotFound('Folder');
		if (!EMPTYABLE_ROLES.has(folder.role ?? '')) {
			throwInvalidInput('Only Trash and Spam can be emptied');
		}
		const access = await requireMailboxAccess(ctx, folder.mailboxId, 'owner', session);
		if (!access.ok) throwForbidden('You do not have permission to empty this folder.');
		return await emptyFolderRun(ctx, folder, await highestUid(ctx, folder._id));
	},
});

/**
 * The rest of an `emptyFolder` too large for one transaction. Scheduled only by
 * `emptyFolderRun`, after the public mutation's owner check passed.
 */
export const continueEmptyFolder = internalMutation({
	args: { folderId: v.id('mailFolders'), ceilingUid: v.number() },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return;
		await emptyFolderRun(ctx, folder, args.ceilingUid);
	},
});
