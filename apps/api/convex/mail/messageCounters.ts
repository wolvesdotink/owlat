/**
 * The Postbox's maintained counts (plan 3.1), on the `lib/counters.ts` engine.
 *
 *   - `mailLabelUnread:<mailboxId>` — unread messages per label, mailbox-wide
 *     (every folder, snoozed included), which is what the label rail has always
 *     tallied. Bucket: the label id.
 *   - `mailSectionUnread:<folderId>` — unread, not-snoozed messages per split-
 *     inbox section. Bucket: `pinnedSection`, or `''` for an unstamped row.
 *     "Snoozed" here is the `snoozedUntil` COLUMN being set, the same test the
 *     folder `unseenCount` uses (see `snooze.ts`): the count comes back when the
 *     wake sweep clears the column, not the instant the wake time passes.
 *   - `mailFolderArrivals:<folderId>` — every message in the folder, bucketed by
 *     the UTC hour it was received. The Workbench's "new mail since you looked"
 *     is a range sum over these plus a scan of one partial hour.
 *
 * The folder scopes are created for inbox folders only (that is all that reads
 * them); a message write in any other folder finds no scope row and costs one
 * indexed read.
 *
 * {@link recordMessageCounters} is the one hook. Every write that creates,
 * deletes or changes `flagSeen`, `labelIds`, `folderId`, `pinnedSection` or
 * `snoozedUntil` on a message calls it with the row before and after the write.
 * Inserts that are read and unlabeled (a sent copy) contribute to no unread
 * bucket, and every such insert lands outside the inbox, so they skip it.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import {
	AFTER_EVERY_ROW,
	applyCounterChange,
	clearCounterScope,
	counterScopeKey,
	loadCounterScope,
	readCounterScope,
	startCounterScope,
	type CounterPosition,
} from '../lib/counters';

/** The fields of a message the Postbox counters depend on. */
export type CountedMessage = Pick<
	Doc<'mailMessages'>,
	| 'mailboxId'
	| 'folderId'
	| 'flagSeen'
	| 'labelIds'
	| 'receivedAt'
	| 'pinnedSection'
	| 'snoozedUntil'
> & { _creationTime?: number };

const HOUR_MS = 60 * 60 * 1000;

/** Fixed-width hour key, so bucket strings sort in time order. */
export function arrivalHourKey(receivedAt: number): string {
	return String(Math.floor(receivedAt / HOUR_MS)).padStart(10, '0');
}

export function labelUnreadBuckets(m: CountedMessage): readonly string[] {
	return m.flagSeen ? [] : m.labelIds;
}

export function sectionUnreadBuckets(m: CountedMessage): readonly string[] {
	if (m.flagSeen || m.snoozedUntil != null) return [];
	return [m.pinnedSection || ''];
}

export function arrivalBuckets(m: CountedMessage): readonly string[] {
	return [arrivalHourKey(m.receivedAt)];
}

/**
 * Where a message sits in `by_mailbox_and_received` / `by_folder_and_received`,
 * the indexes the backfill walks. A row being inserted has no creation time yet
 * and sorts after every existing row with the same `receivedAt`.
 */
export function messagePosition(m: CountedMessage): CounterPosition {
	return { key: m.receivedAt, creationTime: m._creationTime ?? AFTER_EVERY_ROW };
}

export const labelUnreadScope = (mailboxId: Id<'mailboxes'>) =>
	counterScopeKey('mailLabelUnread', mailboxId);
export const sectionUnreadScope = (folderId: Id<'mailFolders'>) =>
	counterScopeKey('mailSectionUnread', folderId);
export const folderArrivalsScope = (folderId: Id<'mailFolders'>) =>
	counterScopeKey('mailFolderArrivals', folderId);

async function recordFolderCounters(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>,
	position: CounterPosition,
	before: CountedMessage | null,
	after: CountedMessage | null
): Promise<void> {
	await applyCounterChange(
		ctx,
		sectionUnreadScope(folderId),
		position,
		before ? sectionUnreadBuckets(before) : [],
		after ? sectionUnreadBuckets(after) : []
	);
	await applyCounterChange(
		ctx,
		folderArrivalsScope(folderId),
		position,
		before ? arrivalBuckets(before) : [],
		after ? arrivalBuckets(after) : []
	);
}

/**
 * Move the Postbox counters for one message write: `before` is the row as it
 * was (null for an insert), `after` the row as written (null for a delete).
 * Call it in the same mutation as the write.
 */
export async function recordMessageCounters(
	ctx: MutationCtx,
	before: CountedMessage | null,
	after: CountedMessage | null
): Promise<void> {
	const row = before ?? after;
	if (!row) return;
	const position = messagePosition(row);
	await applyCounterChange(
		ctx,
		labelUnreadScope(row.mailboxId),
		position,
		before ? labelUnreadBuckets(before) : [],
		after ? labelUnreadBuckets(after) : []
	);
	if (before && after && before.folderId === after.folderId) {
		await recordFolderCounters(ctx, before.folderId, position, before, after);
		return;
	}
	if (before) await recordFolderCounters(ctx, before.folderId, position, before, null);
	if (after) await recordFolderCounters(ctx, after.folderId, position, null, after);
}

/**
 * A freshly provisioned mailbox has no mail, so its scopes start out ready and
 * never need a backfill.
 */
export async function startEmptyMailboxCounters(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	inboxFolderId: Id<'mailFolders'>
): Promise<void> {
	await startCounterScope(ctx, 'mailLabelUnread', mailboxId, { isEmpty: true });
	await startCounterScope(ctx, 'mailSectionUnread', inboxFolderId, { isEmpty: true });
	await startCounterScope(ctx, 'mailFolderArrivals', inboxFolderId, { isEmpty: true });
}

/**
 * Drop a folder's counter scopes as the folder row is hard-deleted. Only inbox
 * folders carry scopes; for any other folder this is two indexed reads. The
 * folder's messages are gone by then and every delete moved their buckets back
 * to zero (an empty bucket is no row), so one clearing pass takes the rest.
 */
export async function deleteFolderCounters(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>
): Promise<void> {
	await clearCounterScope(ctx, sectionUnreadScope(folderId));
	await clearCounterScope(ctx, folderArrivalsScope(folderId));
}

/** Drop the mailbox-wide counter scope as the mailbox row is hard-deleted. */
export async function deleteMailboxCounters(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	await clearCounterScope(ctx, labelUnreadScope(mailboxId));
}

/** Unread count per label id, or null until the mailbox's scope is backfilled. */
export async function readLabelUnreadCounts(
	db: DatabaseReader,
	mailboxId: Id<'mailboxes'>
): Promise<Map<string, number> | null> {
	return readCounterScope(db, labelUnreadScope(mailboxId));
}

/** Unread count per section name (`''` = unstamped), or null until backfilled. */
export async function readSectionUnreadCounts(
	db: DatabaseReader,
	folderId: Id<'mailFolders'>
): Promise<Map<string, number> | null> {
	return readCounterScope(db, sectionUnreadScope(folderId));
}

/**
 * How many messages in `folderId` were received after `since`, counting up to
 * `cap` (past it the answer is `{ count: cap, isCapped: true }`), or null until
 * the folder's arrivals scope is backfilled.
 *
 * The hour `since` falls in is read row by row (only its part after `since`
 * counts); every later hour is one bucket row. Both reads stop as soon as the
 * running total passes the cap, so the cost is bounded by the cap either way.
 */
export async function countFolderArrivalsSince(
	db: DatabaseReader,
	folderId: Id<'mailFolders'>,
	since: number,
	cap: number
): Promise<{ count: number; isCapped: boolean } | null> {
	const scope = folderArrivalsScope(folderId);
	const state = await loadCounterScope(db, scope);
	if (!state?.isReady) return null;

	const hourEnd = (Math.floor(since / HOUR_MS) + 1) * HOUR_MS;
	const partial = await db
		.query('mailMessages')
		.withIndex('by_folder_and_received', (q) =>
			q.eq('folderId', folderId).gt('receivedAt', since).lt('receivedAt', hourEnd)
		)
		.take(cap + 1);
	let total = partial.length;
	if (total > cap) return { count: cap, isCapped: true };

	for await (const row of db
		.query('counterBuckets')
		.withIndex('by_scope_and_bucket', (q) =>
			q.eq('scope', scope).gt('bucket', arrivalHourKey(since))
		)) {
		total += row.count;
		if (total > cap) return { count: cap, isCapped: true };
	}
	return { count: total, isCapped: false };
}
