/**
 * Whole-folder chores: "Mark all as read" (for a folder, a label or one
 * smart-inbox category of a folder) and "Empty Trash / Spam".
 *
 * They act on a folder or label rather than on a selection, so none is capped
 * at the selection's 500 ids, and each stops where the folder or mailbox stood
 * when the person asked: a message that arrives (or is moved in, which
 * allocates a new uid) after the click is not part of what they cleared.
 *
 * Marking read is driven by the client one bounded batch at a time, because
 * each batch hands back the ids it flipped and the client's Undo needs every
 * one of them. Emptying has no Undo, so it continues on the scheduler and
 * finishes even if the tab closes.
 */

import { v } from 'convex/values';
import { mailCategoryLabelValidator } from '../lib/literalValidators';
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
import { rowsAfterTied, type DrainBudget } from './interpret/purgeDrain';

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
 * Mark the messages of one batch read, skipping snoozed ones: they are not in
 * the view the person is looking at, and they should come back unread. Returns
 * the ids it flipped, which the client's Undo puts back.
 */
async function markMessagesRead(
	ctx: MutationCtx,
	messages: readonly Doc<'mailMessages'>[]
): Promise<Id<'mailMessages'>[]> {
	const now = Date.now();
	const folders = new FolderFlagWrites(ctx);
	const threads: ThreadFlagDeltas = new Map();
	const remote: RemoteChange[] = [];
	const markedIds: Id<'mailMessages'>[] = [];
	for (const message of messages) {
		if (message.flagSeen || isMessageSnoozed(message, now)) continue;
		const change = await writeMessageFlags(ctx, folders, threads, message, { seen: true });
		if (!change) continue;
		remote.push(change);
		markedIds.push(message._id);
	}
	await folders.flush();
	await applyThreadFlagDeltas(ctx, threads);
	await recordRemoteChanges(ctx, remote);
	return markedIds;
}

/**
 * One batch of a folder's unread messages up to `ceilingUid`, and the cursor
 * for the next batch (null once the folder holds no more).
 */
async function unreadFolderBatch(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>,
	cursor: { ceilingUid: number; afterUid: number }
): Promise<{ batch: Doc<'mailMessages'>[]; afterUid: number | null }> {
	const batch = await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_and_seen', (q) =>
			q
				.eq('folderId', folderId)
				.eq('flagSeen', false)
				.gt('uid', cursor.afterUid)
				.lte('uid', cursor.ceilingUid)
		)
		.take(MARK_FOLDER_READ_BATCH);
	const last = batch[batch.length - 1];
	return { batch, afterUid: batch.length === MARK_FOLDER_READ_BATCH && last ? last.uid : null };
}

/**
 * Mark one batch of a folder's unread messages read.
 *
 * The first call omits `ceilingUid` and `afterUid`; the answer carries both for
 * the next call, and `afterUid: null` once the folder holds no more unread mail
 * up to the ceiling. Snoozed messages are skipped.
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
		const { batch, afterUid } = await unreadFolderBatch(ctx, folder._id, {
			ceilingUid,
			afterUid: args.afterUid ?? 0,
		});
		return { markedIds: await markMessagesRead(ctx, batch), ceilingUid, afterUid };
	},
});

/**
 * Mark one batch of a smart-inbox category's unread messages in a folder read:
 * the Categories view's section header. It walks the folder exactly as
 * `markFolderRead` does and keeps the messages whose conversation carries the
 * category. A conversation the classifier has not reached yet counts as
 * `other`, the section the view files it under.
 */
// authz: requireMailboxAccess on the folder's mailbox (member floor, the same
// one setFlags applies per message).
export const markCategoryRead = postboxMutation({
	args: {
		folderId: v.id('mailFolders'),
		category: mailCategoryLabelValidator,
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
		const { batch, afterUid } = await unreadFolderBatch(ctx, folder._id, {
			ceilingUid,
			afterUid: args.afterUid ?? 0,
		});
		const categoryOf = new Map<Id<'mailThreads'>, string>();
		const inCategory: Doc<'mailMessages'>[] = [];
		for (const message of batch) {
			let category = categoryOf.get(message.threadId);
			if (category === undefined) {
				const thread = await ctx.db.get(message.threadId);
				category = thread?.category?.label ?? 'other';
				categoryOf.set(message.threadId, category);
			}
			if (category === args.category) inCategory.push(message);
		}
		return { markedIds: await markMessagesRead(ctx, inCategory), ceilingUid, afterUid };
	},
});

/**
 * `rowsAfterTied` charges the rows it reads past inside one creation time to a
 * budget. A label batch has no budget beyond its own row count: the rows it
 * passes over are the ones earlier batches of this walk read in that creation
 * time and left unread, so they are bounded by what one transaction can write
 * at a single creation time.
 */
const UNMETERED: DrainBudget = {
	isExhausted: () => false,
	chunk: (max) => max,
	charge: () => {},
	range: () => {},
	progress: () => {},
};

/**
 * Mark one batch of a label's unread messages read, in whichever folder they
 * are filed: the label view lists them all.
 *
 * There is no index over label membership (Convex indexes an array field by
 * its whole value), so a batch reads up to MARK_FOLDER_READ_BATCH of the
 * mailbox's unread messages in creation order and keeps the labelled ones. The
 * cursor is the creation time and id of the last row read: many messages share
 * one creation time (an import batch), and the index orders those by id, so a
 * creation time alone would skip the rest of a tie. The ceiling is the
 * creation time of the newest unread message at the first call, so later
 * arrivals stay unread. A batch can flip nothing and still hand back a cursor.
 */
// authz: requireMailboxAccess on the label's mailbox (member floor, the same
// one setFlags applies per message); the label must belong to that mailbox.
export const markLabelRead = postboxMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		labelId: v.id('mailLabels'),
		ceilingTime: v.optional(v.number()),
		afterTime: v.optional(v.number()),
		afterId: v.optional(v.id('mailMessages')),
	},
	handler: async (
		ctx,
		args,
		session
	): Promise<{
		markedIds: Id<'mailMessages'>[];
		ceilingTime: number;
		afterTime: number | null;
		afterId: Id<'mailMessages'> | null;
	}> => {
		const label = await ctx.db.get(args.labelId);
		if (!label || label.mailboxId !== args.mailboxId) throwNotFound('Label');
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!access.ok) throwForbidden('Label not accessible');

		const ceilingTime =
			args.ceilingTime ??
			(
				await ctx.db
					.query('mailMessages')
					.withIndex('by_mailbox_and_unseen', (q) =>
						q.eq('mailboxId', args.mailboxId).eq('flagSeen', false)
					)
					.order('desc')
					.first()
			)?._creationTime ??
			0;
		const after =
			args.afterTime === undefined ? undefined : { at: args.afterTime, key: args.afterId ?? '' };
		const batch = await rowsAfterTied(UNMETERED, after, MARK_FOLDER_READ_BATCH, (bound) =>
			ctx.db.query('mailMessages').withIndex('by_mailbox_and_unseen', (q) => {
				const unseen = q.eq('mailboxId', args.mailboxId).eq('flagSeen', false);
				if (bound === undefined) return unseen.lte('_creationTime', ceilingTime);
				if ('eq' in bound) return unseen.eq('_creationTime', bound.eq);
				return unseen.gt('_creationTime', bound.gt).lte('_creationTime', ceilingTime);
			})
		);
		const labelled = batch.filter((message) => message.labelIds.includes(args.labelId));
		const last = batch.length === MARK_FOLDER_READ_BATCH ? batch[batch.length - 1] : undefined;
		return {
			markedIds: await markMessagesRead(ctx, labelled),
			ceilingTime,
			afterTime: last?._creationTime ?? null,
			afterId: last?._id ?? null,
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
