/**
 * The label membership rows (`schema/mailLabelMembership.ts`): one
 * `mailLabelMessages` row per (message, label) pair, so the label view and the
 * thread label reconciliation range over an index instead of reading messages
 * and testing `labelIds`.
 *
 * WRITERS: every write that inserts a labeled message, changes a message's
 * `labelIds` or deletes a message calls {@link recordLabelMembership} with the
 * row before and after, in the same transaction. That runs whether or not the
 * mailbox is ready yet, so the rows never hold a pair the message lacks, and a
 * message written after this shipped has all of its pairs.
 *
 * BACKFILL: messages written before have pairs only once
 * {@link backfillLabelMembershipStep} walks their mailbox (migration 0073).
 * The walk adds the missing pairs of each message in its current state, and a
 * write that lands before or after the walk passes a message keeps the rows
 * exact either way, so the walk needs no watermark. Readers use the rows only
 * once the mailbox's `mailLabelMembership` row is ready; until then they keep
 * the message scans.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import { isMessageSnoozed } from '../lib/mailSnooze';

/** The fields of a message its label rows are derived from. */
export type LabelMemberMessage = Pick<
	Doc<'mailMessages'>,
	'_id' | 'mailboxId' | 'threadId' | 'labelIds' | 'receivedAt'
>;

async function loadState(
	db: DatabaseReader,
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailLabelMembership'> | null> {
	return db
		.query('mailLabelMembership')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
}

/** Whether the mailbox's label rows are complete and readers may use them. */
export async function isLabelMembershipReady(
	db: DatabaseReader,
	mailboxId: Id<'mailboxes'>
): Promise<boolean> {
	return (await loadState(db, mailboxId))?.isReady === true;
}

async function findRow(
	db: DatabaseReader,
	messageId: Id<'mailMessages'>,
	labelId: Id<'mailLabels'>
): Promise<Doc<'mailLabelMessages'> | null> {
	return db
		.query('mailLabelMessages')
		.withIndex('by_message_and_label', (q) => q.eq('messageId', messageId).eq('labelId', labelId))
		.first();
}

async function insertRow(
	ctx: MutationCtx,
	message: LabelMemberMessage,
	labelId: Id<'mailLabels'>
): Promise<void> {
	await ctx.db.insert('mailLabelMessages', {
		mailboxId: message.mailboxId,
		labelId,
		messageId: message._id,
		threadId: message.threadId,
		receivedAt: message.receivedAt,
	});
}

/** Insert the pair unless it is already there. True when a row was written. */
async function ensureRow(
	ctx: MutationCtx,
	message: LabelMemberMessage,
	labelId: Id<'mailLabels'>
): Promise<boolean> {
	if (await findRow(ctx.db, message._id, labelId)) return false;
	await insertRow(ctx, message, labelId);
	return true;
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Move one message's label rows from `before` (null for an insert) to `after`
 * (null for a delete). Call it in the mutation that writes the message.
 */
export async function recordLabelMembership(
	ctx: MutationCtx,
	before: LabelMemberMessage | null,
	after: LabelMemberMessage | null
): Promise<void> {
	if (!before) {
		// A message being inserted has no rows yet.
		if (after) for (const labelId of new Set(after.labelIds)) await insertRow(ctx, after, labelId);
		return;
	}
	if (after && sameLabels(before.labelIds, after.labelIds)) return;
	const kept = new Set(after?.labelIds ?? []);
	for (const labelId of new Set(before.labelIds)) {
		if (kept.has(labelId)) continue;
		const row = await findRow(ctx.db, before._id, labelId);
		if (row) await ctx.db.delete(row._id);
	}
	if (!after) return;
	const had = new Set(before.labelIds);
	for (const labelId of kept) {
		// A message written before the rows existed may lack pairs it already had.
		if (!had.has(labelId)) await ensureRow(ctx, after, labelId);
	}
}

/**
 * Whether any message of the thread carries the label, or null while the
 * mailbox's rows are not ready (the caller scans the thread's messages).
 */
export async function threadHasLabel(
	db: DatabaseReader,
	thread: Pick<Doc<'mailThreads'>, '_id' | 'mailboxId'>,
	labelId: Id<'mailLabels'>
): Promise<boolean | null> {
	if (!(await isLabelMembershipReady(db, thread.mailboxId))) return null;
	const row = await db
		.query('mailLabelMessages')
		.withIndex('by_thread_and_label', (q) => q.eq('threadId', thread._id).eq('labelId', labelId))
		.first();
	return row !== null;
}

/** A provisioned mailbox holds no mail, so its rows start out complete. */
export async function startEmptyLabelMembership(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	if (await loadState(ctx.db, mailboxId)) return;
	const now = Date.now();
	await ctx.db.insert('mailLabelMembership', {
		mailboxId,
		isReady: true,
		cursor: null,
		startedAt: now,
		completedAt: now,
		updatedAt: now,
	});
}

/**
 * Drop the mailbox's state row as the mailbox row is hard-deleted. Its pair
 * rows went with its messages (`deleteMessageRowAndBlobs`).
 */
export async function deleteLabelMembershipState(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	const state = await loadState(ctx.db, mailboxId);
	if (state) await ctx.db.delete(state._id);
}

/**
 * One bounded step of a mailbox's backfill: add the missing pairs of the next
 * `pageSize` messages, and mark the mailbox ready after its last page.
 * Idempotent, and a ready mailbox costs one read.
 */
export async function backfillLabelMembershipStep(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	pageSize: number
): Promise<{ isReady: boolean; scanned: number; changed: number }> {
	const now = Date.now();
	let state = await loadState(ctx.db, mailboxId);
	if (state?.isReady) return { isReady: true, scanned: 0, changed: 0 };
	if (!state) {
		const id = await ctx.db.insert('mailLabelMembership', {
			mailboxId,
			isReady: false,
			cursor: null,
			startedAt: now,
			updatedAt: now,
		});
		state = (await ctx.db.get(id))!;
	}
	const { page, continueCursor, isDone } = await ctx.db
		.query('mailMessages')
		.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailboxId))
		.paginate({ numItems: pageSize, cursor: state.cursor });
	let changed = 0;
	for (const message of page) {
		for (const labelId of new Set(message.labelIds)) {
			if (await ensureRow(ctx, message, labelId)) changed += 1;
		}
	}
	await ctx.db.patch(
		state._id,
		isDone
			? { isReady: true, cursor: null, completedAt: now, updatedAt: now }
			: { cursor: continueCursor, updatedAt: now }
	);
	return { isReady: isDone, scanned: page.length, changed };
}

/**
 * Rows one label page reads at most. A page fills from the label's rows newest
 * first, skipping snoozed messages; a label with this many snoozed messages in
 * a row returns a short page and a cursor past them.
 */
export const LABEL_PAGE_SCAN_CAP = 1000;

interface LabelCursor {
	receivedAt: number;
	creationTime: number;
}

function encodeCursor(row: Doc<'mailLabelMessages'>): string {
	return `${row.receivedAt}:${row._creationTime}`;
}

function decodeCursor(cursor: string | undefined): LabelCursor | null {
	if (!cursor) return null;
	const [receivedAt, creationTime] = cursor.split(':').map(Number);
	if (!Number.isFinite(receivedAt) || !Number.isFinite(creationTime)) return null;
	return { receivedAt: receivedAt!, creationTime: creationTime! };
}

/**
 * One page of the label's visible (not snoozed) messages, newest first, or
 * null while the mailbox's rows are not ready.
 *
 * Keyset-paged on `(receivedAt, _creationTime)` of the row, the order the
 * index returns: the cursor names the last row the page consumed, and the next
 * page starts strictly after it. `hasMore` means another visible message
 * follows, or the scan cap stopped the page early.
 */
export async function readLabelPage(
	db: DatabaseReader,
	mailboxId: Id<'mailboxes'>,
	labelId: Id<'mailLabels'>,
	options: { limit: number; cursor?: string; now: number }
): Promise<{
	messages: Doc<'mailMessages'>[];
	hasMore: boolean;
	nextCursor: string | null;
} | null> {
	if (!(await isLabelMembershipReady(db, mailboxId))) return null;
	const after = decodeCursor(options.cursor);
	const rows = db
		.query('mailLabelMessages')
		.withIndex('by_mailbox_and_label_and_received', (q) => {
			const label = q.eq('mailboxId', mailboxId).eq('labelId', labelId);
			return after ? label.lte('receivedAt', after.receivedAt) : label;
		})
		.order('desc');

	const messages: Doc<'mailMessages'>[] = [];
	let lastReturned: Doc<'mailLabelMessages'> | null = null;
	let lastScanned: Doc<'mailLabelMessages'> | null = null;
	let scanned = 0;
	let hasMore = false;
	for await (const row of rows) {
		// Rows sharing the cursor's arrival time sort by creation time, newest
		// first: those at or above the cursor's were on an earlier page.
		if (after && row.receivedAt === after.receivedAt && row._creationTime >= after.creationTime) {
			continue;
		}
		if (scanned === LABEL_PAGE_SCAN_CAP) {
			hasMore = true;
			break;
		}
		scanned += 1;
		lastScanned = row;
		const message = await db.get(row.messageId);
		if (!message || isMessageSnoozed(message, options.now)) continue;
		if (messages.length === options.limit) {
			hasMore = true;
			break;
		}
		messages.push(message);
		lastReturned = row;
	}
	// A full page resumes after its last message, so the visible row found
	// past it is the next page's first; a short one resumes after all it read.
	const resumeAt = messages.length === options.limit ? lastReturned : lastScanned;
	return {
		messages,
		hasMore,
		nextCursor: hasMore && resumeAt ? encodeCursor(resumeAt) : null,
	};
}
