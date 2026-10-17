/**
 * Read on arrival: what a message purge and a scope conversion take with them
 * (SPEC §0 "erasure", §2.9).
 *
 *  - {@link deleteMailMessageArrivalRows}: called from
 *    `deleteMessageRowAndBlobs` (the one way a message row is destroyed). The
 *    message's arrival record and delayed actions go, the undo-log change rows
 *    naming it go, its lines leave every unsent digest, and a thread projection
 *    that pointed at it is cleared (the next input change recomputes it).
 *  - {@link clearSharedThreadArrival}: a personal mailbox that becomes a team
 *    inbox (`mail/interpret/scopeChange.ts startScopeChange`). The thread's
 *    projection, Fix override and digest eligibility are cleared, and its
 *    arrival records are deleted: inline up to a page, the rest by
 *    `scopeDrain.ts drainThreadRecords`.
 *
 * Mailbox erasure and the organization wipe delete whole tables by mailbox
 * (`auth/erasure/arrivalPhases.ts`, the wipe steps); retention ages rows out by
 * `expiresAt` (`maintenance/retention.ts`).
 */

import { internal } from '../../_generated/api';
import type { Doc, Id, TableNames } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';

/** Rows of one per-message range read per query; a message has a handful. */
const MESSAGE_PAGE = 16;
/** Unsent digests of one state read per purged message; a mailbox has one or two. */
const UNSENT_DIGEST_SCAN = 8;
/** Arrival records a scope conversion deletes per transaction. */
const SCOPE_RECORD_PAGE = 100;

/** Delete every row `read` returns, page by page, until a page comes back short. */
async function drain(
	ctx: MutationCtx,
	read: (n: number) => Promise<Array<{ _id: Id<TableNames> }>>
): Promise<void> {
	for (;;) {
		const rows = await read(MESSAGE_PAGE);
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length < MESSAGE_PAGE) return;
	}
}

/** Everything read on arrival keeps about one message, removed with it. */
export async function deleteMailMessageArrivalRows(
	ctx: MutationCtx,
	message: Pick<Doc<'mailMessages'>, '_id' | 'mailboxId' | 'threadId'>
): Promise<void> {
	const messageId = message._id;
	await drain(ctx, (n) =>
		ctx.db
			.query('mailArrivalRecords')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.take(n)
	);
	await drain(ctx, (n) =>
		ctx.db
			.query('mailDelayedActions')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.take(n)
	);
	await drain(ctx, (n) =>
		ctx.db
			.query('mailArrivalOperationChanges')
			.withIndex('by_message', (q) => q.eq('messageId', messageId))
			.take(n)
	);
	for (const state of ['claimed', 'generated', 'failed'] as const) {
		const digests = await ctx.db
			.query('mailDigests')
			.withIndex('by_mailbox_state', (q) => q.eq('mailboxId', message.mailboxId).eq('state', state))
			.take(UNSENT_DIGEST_SCAN);
		for (const digest of digests) {
			const items = digest.items.filter((item) => item.messageId !== messageId);
			if (items.length !== digest.items.length) await ctx.db.patch(digest._id, { items });
		}
	}
	const thread = await ctx.db.get(message.threadId);
	if (thread?.arrival?.messageId === messageId) {
		await ctx.db.patch(thread._id, { arrival: undefined, digestPendingSince: undefined });
	}
}

/** Delete up to one page of a thread's arrival records. True when none are left. */
export async function deleteThreadRecordsPage(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<boolean> {
	const records = await ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_thread_created', (q) => q.eq('threadId', threadId))
		.take(SCOPE_RECORD_PAGE);
	for (const record of records) await ctx.db.delete(record._id);
	return records.length < SCOPE_RECORD_PAGE;
}

/**
 * A thread whose mailbox became a team inbox: no personal placement, override,
 * digest eligibility or arrival record survives. The gist on its brief is
 * cleared by `startScopeChange` with the rest of the brief-mode state.
 */
export async function clearSharedThreadArrival(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	if (
		thread.arrival ||
		thread.placementOverride ||
		thread.digestPendingSince !== undefined ||
		thread.lastArrivalOperationId
	) {
		await ctx.db.patch(threadId, {
			arrival: undefined,
			placementOverride: undefined,
			digestPendingSince: undefined,
			lastArrivalOperationId: undefined,
		});
	}
	if (!(await deleteThreadRecordsPage(ctx, threadId))) {
		await ctx.scheduler.runAfter(0, internal.mail.arrival.scopeDrain.drainThreadRecords, {
			threadId,
		});
	}
}
