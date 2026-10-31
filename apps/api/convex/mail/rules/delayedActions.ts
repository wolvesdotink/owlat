/**
 * Read on arrival: delayed actions. A rule's `archiveAfter` and
 * the opt-in code detector each create ONE delayed archive of the message
 * they matched, anchored on that message (its receive time, its order key,
 * the folder it sat in), deduplicated by `actionKey`.
 *
 * A cron every 5 minutes reads due rows from `by_state_run` (bounded) and
 * schedules each in its own mutation, which re-checks everything in the same
 * transaction as the archive and cancels instead when any of these hold:
 *
 *   - the owner sent a message in the thread at or after the anchor (a reply
 *     to the triggering message, not merely one since the row was created)
 *   - the message is flagged
 *   - the message is no longer in the anchor folder (moved by hand or by
 *     anything else)
 *   - the thread has a needs-reply verdict newer than the anchor
 *   - the operation that created it was undone
 *
 * Only that message is archived (`archiveSingleMessage`), and the execution
 * is logged as a `delayed_archive` operation with its `messageFolder` change
 * row in the same mutation.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import { HOUR_MS } from '../../lib/constants';
import { isPersonalMailbox } from '../permissions';
import { archiveSingleMessage } from '../archiveSingleMessage';
import { refreshArrivalProjection } from '../arrival/projection';
import { sourceOrderKey } from '../interpret/sourceOrder';
import { RuleOperationLog } from './operationLog';

/** Due rows one cron tick schedules. */
export const DELAYED_ACTION_BATCH = 100;

/** Folders whose mail there is nothing to archive from. */
const SETTLED_ROLES: ReadonlySet<string> = new Set(['archive', 'trash', 'spam', 'sent', 'drafts']);

type DelayedAction = Doc<'mailDelayedActions'>;
type CancelReason = NonNullable<DelayedAction['cancelledBy']>;
type DelayedSource = DelayedAction['source'];

/** The unique key of one message's delayed archive from one source. Pure. */
export function delayedActionKey(messageId: Id<'mailMessages'>, source: DelayedSource): string {
	return `${messageId}:archive:${source}`;
}

/**
 * Why a delayed archive should not run (now, or at creation), or null.
 * Reads the message, its thread and the creating operation.
 */
export async function delayedCancelReason(
	ctx: Pick<MutationCtx, 'db'>,
	row: Pick<DelayedAction, 'messageId' | 'threadId' | 'anchor' | 'createdByOperationId'>
): Promise<CancelReason | null> {
	const message = await ctx.db.get(row.messageId);
	if (!message || message.folderId !== row.anchor.folderId) return 'moved';
	if (message.flagFlagged) return 'flag';
	if (row.createdByOperationId) {
		const operation = await ctx.db.get(row.createdByOperationId);
		if (operation && operation.status !== 'applied') return 'undo';
	}
	const thread = await ctx.db.get(row.threadId);
	if ((thread?.needsReply?.detectedAt ?? 0) > row.anchor.messageReceivedAt) return 'reply';
	const mailbox = await ctx.db.get(message.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return 'moved';
	if (await hasOwnerReplySince(ctx, mailbox, row.threadId, row.anchor.messageReceivedAt)) {
		return 'reply';
	}
	return null;
}

/** Outbound states that mean the owner replied (or is about to: undo-send). */
const REPLIED_STATES = ['queued', 'sent', 'partial', 'bounced'] as const;

/**
 * Whether the owner sent anything in the thread at or after `since`, proved by
 * index-backed `.first()` reads, never a truncated scan: an outbound send
 * created since then, a message in Sent received since then (a synced Sent
 * copy), or a message from the owner's address received since then (one filed
 * elsewhere).
 */
export async function hasOwnerReplySince(
	ctx: Pick<MutationCtx, 'db'>,
	mailbox: Doc<'mailboxes'>,
	threadId: Id<'mailThreads'>,
	since: number
): Promise<boolean> {
	for (const state of REPLIED_STATES) {
		const sent = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_and_outbound_state', (q) =>
				q.eq('threadId', threadId).eq('outbound.state', state).gte('_creationTime', since)
			)
			.first();
		if (sent) return true;
	}
	const sentFolder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailbox._id).eq('role', 'sent'))
		.first();
	if (sentFolder) {
		const copy = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_folder_received', (q) =>
				q.eq('threadId', threadId).eq('folderId', sentFolder._id).gte('receivedAt', since)
			)
			.first();
		if (copy) return true;
	}
	for (const address of new Set([mailbox.address, mailbox.address.toLowerCase()])) {
		const own = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread_from_received', (q) =>
				q.eq('threadId', threadId).eq('fromAddress', address).gte('receivedAt', since)
			)
			.first();
		if (own) return true;
	}
	return false;
}

/**
 * Create one message's delayed archive, unless one exists for this source or
 * a cancel condition already holds. Returns the new row's id, or null.
 */
export async function createDelayedArchive(
	ctx: MutationCtx,
	args: {
		message: Doc<'mailMessages'>;
		hours: number;
		source: DelayedSource;
		filterId?: Id<'mailFilters'>;
		operationId?: Id<'mailArrivalOperations'>;
		now: number;
	}
): Promise<Id<'mailDelayedActions'> | null> {
	const { message, now } = args;
	const actionKey = delayedActionKey(message._id, args.source);
	const existing = await ctx.db
		.query('mailDelayedActions')
		.withIndex('by_action_key', (q) => q.eq('actionKey', actionKey))
		.first();
	if (existing) return null;
	const folder = await ctx.db.get(message.folderId);
	if (!folder || (folder.role !== undefined && SETTLED_ROLES.has(folder.role))) return null;
	const row = {
		messageId: message._id,
		threadId: message.threadId,
		anchor: {
			messageReceivedAt: message.receivedAt,
			messageSourceOrderKey: sourceOrderKey(message),
			folderId: message.folderId,
		},
		...(args.operationId ? { createdByOperationId: args.operationId } : {}),
	};
	if (await delayedCancelReason(ctx, row)) return null;
	return await ctx.db.insert('mailDelayedActions', {
		mailboxId: message.mailboxId,
		...row,
		actionKey,
		action: 'archive',
		runAt: now + args.hours * HOUR_MS,
		source: args.source,
		...(args.filterId ? { filterId: args.filterId } : {}),
		state: 'pending',
		createdAt: now,
		updatedAt: now,
	});
}

/**
 * Undo of the operation that created them cancels a message's pending rows
 * (lane learn's `operations.undo` calls this). Returns how many it cancelled.
 */
export async function cancelDelayedActionsOf(
	ctx: MutationCtx,
	operation: Pick<Doc<'mailArrivalOperations'>, '_id' | 'messageId'>
): Promise<number> {
	if (!operation.messageId) return 0;
	const rows = await ctx.db
		.query('mailDelayedActions')
		.withIndex('by_message', (q) => q.eq('messageId', operation.messageId!))
		.take(10);
	let cancelled = 0;
	const now = Date.now();
	for (const row of rows) {
		if (row.state !== 'pending' || row.createdByOperationId !== operation._id) continue;
		await ctx.db.patch(row._id, { state: 'cancelled', cancelledBy: 'undo', updatedAt: now });
		cancelled += 1;
	}
	return cancelled;
}

/** Run one due delayed archive: re-check, then archive and log, or cancel. */
export async function executeDelayedAction(
	ctx: MutationCtx,
	actionId: Id<'mailDelayedActions'>,
	now: number
): Promise<'done' | 'cancelled' | 'skipped'> {
	const row = await ctx.db.get(actionId);
	if (!row || row.state !== 'pending' || row.runAt > now) return 'skipped';
	const reason = await delayedCancelReason(ctx, row);
	if (reason) {
		await ctx.db.patch(row._id, { state: 'cancelled', cancelledBy: reason, updatedAt: now });
		return 'cancelled';
	}
	const log = new RuleOperationLog(
		ctx,
		{
			mailboxId: row.mailboxId,
			kind: 'delayed_archive',
			actor: row.source === 'rule' ? 'rule' : 'system',
			threadId: row.threadId,
			messageId: row.messageId,
			...(row.filterId ? { filterId: row.filterId } : {}),
		},
		now
	);
	const move = await archiveSingleMessage(ctx, row.messageId);
	if (move) {
		const change = {
			kind: 'messageFolder' as const,
			messageId: row.messageId,
			before: move.sourceFolderId,
			after: move.targetFolderId,
		};
		await log.add(change, move.isNeedsReplyCleared);
	}
	const operationId = await log.finish();
	await ctx.db.patch(row._id, {
		state: 'done',
		...(operationId ? { operationId } : {}),
		updatedAt: now,
	});
	await refreshArrivalProjection(ctx, row.threadId);
	return 'done';
}

/** The cron (every 5 minutes): schedule each due row in its own mutation. */
export const runDue = internalMutation({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args): Promise<number> => {
		const now = args.now ?? Date.now();
		const due = await ctx.db
			.query('mailDelayedActions')
			.withIndex('by_state_run', (q) => q.eq('state', 'pending').lte('runAt', now))
			.take(DELAYED_ACTION_BATCH);
		for (const row of due) {
			await ctx.scheduler.runAfter(0, internal.mail.rules.delayedActions.executeOne, {
				actionId: row._id,
			});
		}
		return due.length;
	},
});

/** One delayed action, transactionally re-checked (see the module doc). */
export const executeOne = internalMutation({
	args: { actionId: v.id('mailDelayedActions') },
	handler: async (ctx, args): Promise<void> => {
		await executeDelayedAction(ctx, args.actionId, Date.now());
	},
});
