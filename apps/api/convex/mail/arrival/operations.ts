/**
 * Read on arrival, Undo (SPEC §4.4): `undo({ operationId })` puts back what
 * one operation changed.
 *
 * One bounded mutation per page of ≤{@link UNDO_PAGE} change rows: the public
 * mutation runs the first page and schedules {@link undoPage} for the rest.
 * Each row is restored only while its guards hold (`./undoChanges.ts`);
 * otherwise it is skipped and the operation ends `undo_partial`. The operation
 * is marked undone on the first page, so a second Undo (or a scheduled
 * settlement under the same operation) sees it is no longer applied.
 *
 * Each page also cancels the pending delayed actions the operation created
 * (`createdByOperationId`) for the messages it names, and recomputes the
 * projections it touched; a restored sender is re-sorted in its own scheduled
 * mutation ({@link resortSender}), one bounded page each.
 *
 * Not restored: a reply reminder an archive cleared (`moveMessagesToFolder`
 * clears it). The result says so (`isNeedsReplyCleared`), from the rows'
 * `isNeedsReplyCleared` marks. Nor is an external unsubscribe request recalled;
 * the client says that for `unsubscribe` operations.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { throwForbidden, throwNotFound } from '../../_utils/errors';
import { postboxMutation } from '../_helpers';
import { FolderFlagWrites, writeMessageFlags } from '../flagWrites';
import { reconcileThreadLabel } from '../labelsMembership';
import { moveMessagesToFolder } from '../messageActions';
import { requireMailboxAccess } from '../permissions';
import { recordRemoteChanges, type RemoteChange } from '../external/remoteOps';
import { resortSenderThreads } from '../senders/operations';
import { isPersonalMailboxId } from '../senders/profiles';
import { applyThreadFlagDeltas, type ThreadFlagDeltas } from '../threadAggregates';
import { refreshArrivalProjection } from './projection';
import { newUndoBatch, restoreChange, type UndoBatch } from './undoChanges';

type Operation = Doc<'mailArrivalOperations'>;

/** Change rows one undo mutation restores. */
export const UNDO_PAGE = 100;

/**
 * Further change rows the first page looks through for an `isNeedsReplyCleared`
 * mark, so the toast can say it even when the mark sits on a later page.
 */
const NEEDS_REPLY_PROBE = 600;

/** What one Undo did, for the toast. */
export interface UndoResult {
	status: 'undone' | 'undo_partial' | 'not_applied' | 'expired';
	kind: Operation['kind'];
	restored: number;
	skipped: number;
	/** More pages run in the background. */
	hasMore: boolean;
	/** Mail moved back, but a reply reminder its archive cleared did not come back. */
	isNeedsReplyCleared: boolean;
}

async function applyFlags(ctx: MutationCtx, batch: UndoBatch): Promise<void> {
	if (batch.flags.size === 0) return;
	const folders = new FolderFlagWrites(ctx);
	const threads: ThreadFlagDeltas = new Map();
	const remote: RemoteChange[] = [];
	for (const [messageId, deltas] of batch.flags) {
		const message = await ctx.db.get(messageId);
		if (!message) continue;
		const change = await writeMessageFlags(ctx, folders, threads, message, deltas);
		if (change) remote.push(change);
	}
	await folders.flush();
	await applyThreadFlagDeltas(ctx, threads);
	await recordRemoteChanges(ctx, remote);
}

/** Cancel the pending delayed actions this operation created for these messages. */
async function cancelDelayedActions(
	ctx: MutationCtx,
	operation: Operation,
	messageIds: Iterable<Id<'mailMessages'>>
): Promise<void> {
	const now = Date.now();
	for (const messageId of messageIds) {
		const rows = await ctx.db
			.query('mailDelayedActions')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.take(10); // bounded: one per action key (`${messageId}:archive:${source}`)
		for (const row of rows) {
			if (row.state !== 'pending' || row.createdByOperationId !== operation._id) continue;
			await ctx.db.patch(row._id, { state: 'cancelled', cancelledBy: 'undo', updatedAt: now });
		}
	}
}

/** Apply what a page of restored rows collected (see `UndoBatch`). */
async function applyBatch(ctx: MutationCtx, operation: Operation, batch: UndoBatch): Promise<void> {
	// Flags first, while each message still sits in the folder the write counts it in.
	await applyFlags(ctx, batch);
	for (const [targetFolderId, messageIds] of batch.moves) {
		await moveMessagesToFolder(ctx, { messageIds, targetFolderId });
	}
	const now = Date.now();
	for (const { threadId, labelId } of batch.labels.values()) {
		await reconcileThreadLabel(ctx, threadId, labelId, now);
	}
	await cancelDelayedActions(ctx, operation, batch.messages);
	for (const threadId of batch.threads) await refreshArrivalProjection(ctx, threadId);
	for (const profileId of batch.senders) {
		await ctx.scheduler.runAfter(0, internal.mail.arrival.operations.resortSender, { profileId });
	}
}

/** Restore one page of the operation's change rows; schedule the next page. */
async function runPage(
	ctx: MutationCtx,
	operation: Operation,
	cursor: string | null
): Promise<Omit<UndoResult, 'status' | 'kind'>> {
	const page = await ctx.db
		.query('mailArrivalOperationChanges')
		.withIndex('by_operation', (q) => q.eq('operationId', operation._id))
		.paginate({ cursor, numItems: UNDO_PAGE });
	const batch = newUndoBatch();
	if (cursor === null && operation.messageId) batch.messages.add(operation.messageId);
	let restored = 0;
	let skipped = 0;
	for (const row of page.page) {
		if (await restoreChange(ctx, operation, row, batch)) restored += 1;
		else skipped += 1;
	}
	await applyBatch(ctx, operation, batch);
	if (skipped > 0 && operation.status !== 'undo_partial') {
		await ctx.db.patch(operation._id, { status: 'undo_partial' });
	}
	if (!page.isDone) {
		await ctx.scheduler.runAfter(0, internal.mail.arrival.operations.undoPage, {
			operationId: operation._id,
			cursor: page.continueCursor,
		});
	}
	return {
		restored,
		skipped,
		hasMore: !page.isDone,
		isNeedsReplyCleared: batch.isNeedsReplyCleared,
	};
}

/** Whether a later page of the operation carries an `isNeedsReplyCleared` mark. */
async function hasClearedReplyLater(ctx: MutationCtx, operation: Operation): Promise<boolean> {
	const rows = await ctx.db
		.query('mailArrivalOperationChanges')
		.withIndex('by_operation', (q) => q.eq('operationId', operation._id))
		.take(UNDO_PAGE + NEEDS_REPLY_PROBE);
	return rows.slice(UNDO_PAGE).some((row) => row.isNeedsReplyCleared === true);
}

/** Undo one operation (see the module doc). */
// authz: requireMailboxAccess on the operation's mailbox.
export const undo = postboxMutation({
	args: { operationId: v.id('mailArrivalOperations') },
	handler: async (ctx, args, session): Promise<UndoResult> => {
		const operation = await ctx.db.get(args.operationId);
		if (!operation) throwNotFound('Operation');
		const owned = await requireMailboxAccess(ctx, operation.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const none = { kind: operation.kind, restored: 0, skipped: 0, hasMore: false };
		if (operation.status !== 'applied') {
			return { ...none, status: 'not_applied', isNeedsReplyCleared: false };
		}
		const now = Date.now();
		if (operation.expiresAt < now)
			return { ...none, status: 'expired', isNeedsReplyCleared: false };
		await ctx.db.patch(operation._id, { status: 'undone', undoneAt: now });
		const marked = { ...operation, status: 'undone' as const };
		const page = await runPage(ctx, marked, null);
		const isNeedsReplyCleared =
			page.isNeedsReplyCleared || (page.hasMore && (await hasClearedReplyLater(ctx, marked)));
		const status =
			(await ctx.db.get(operation._id))?.status === 'undo_partial' ? 'undo_partial' : 'undone';
		return { ...page, kind: operation.kind, status, isNeedsReplyCleared };
	},
});

/** The next page of an undo the public mutation started (after its access check). */
export const undoPage = internalMutation({
	args: { operationId: v.id('mailArrivalOperations'), cursor: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const operation = await ctx.db.get(args.operationId);
		if (!operation || operation.status === 'applied') return;
		await runPage(ctx, operation, args.cursor);
	},
});

/** Re-sort a sender after its status or override was restored. */
export const resortSender = internalMutation({
	args: { profileId: v.id('mailSenderProfiles') },
	handler: async (ctx, args): Promise<void> => {
		const profile = await ctx.db.get(args.profileId);
		if (!profile || !(await isPersonalMailboxId(ctx, profile.mailboxId))) return;
		await resortSenderThreads(ctx, profile);
	},
});
