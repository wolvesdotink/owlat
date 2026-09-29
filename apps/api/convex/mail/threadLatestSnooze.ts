/**
 * `mailThreads.latestSnoozedUntil`: the snooze of a thread's newest message,
 * copied onto the thread (plan C8).
 *
 * The conversation list hides a thread whose newest message is snoozed. It used
 * to load that message for every candidate thread (up to ~1,500 per read) just
 * to read one field; the copy lets it decide from the thread row alone.
 *
 * Two kinds of write keep it in step:
 *   - a write that moves `latestMessageId` sets it from the new latest message
 *     (a freshly delivered or sent message is never snoozed, so those set
 *     `null`; `rebuildThreadAggregates` copies the real value);
 *   - a write that changes a message's `snoozedUntil` (mail/snooze.ts) calls
 *     {@link syncThreadLatestSnooze} for the message's thread.
 *
 * `undefined` means "not recorded yet" (threads older than the field, until
 * `migrations/0047_denormalize_thread_rows` runs); readers then load the
 * message as before, so a missed backfill costs speed, never correctness.
 *
 * Not a Convex function; helpers shared by the snooze writers and list reads.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { isMessageSnoozed } from '../lib/mailSnooze';

type ThreadSnoozeFields = Pick<Doc<'mailThreads'>, 'latestMessageId' | 'latestSnoozedUntil'>;

/**
 * Whether the thread's newest message is snoozed at `now`. Reads the copy on
 * the thread; only a thread that has none yet loads the message.
 */
export async function isThreadLatestSnoozed(
	ctx: QueryCtx,
	thread: ThreadSnoozeFields,
	now: number
): Promise<boolean> {
	if (thread.latestSnoozedUntil !== undefined) {
		return isMessageSnoozed({ snoozedUntil: thread.latestSnoozedUntil }, now);
	}
	if (!thread.latestMessageId) return false;
	const latest = await ctx.db.get(thread.latestMessageId);
	return latest !== null && isMessageSnoozed(latest, now);
}

/** The value `latestSnoozedUntil` should hold for a thread's current latest message. */
export async function readLatestSnoozedUntil(
	ctx: QueryCtx,
	thread: Pick<Doc<'mailThreads'>, 'latestMessageId'>
): Promise<number | null> {
	if (!thread.latestMessageId) return null;
	const latest = await ctx.db.get(thread.latestMessageId);
	return latest?.snoozedUntil ?? null;
}

/**
 * Re-copy the latest message's snooze onto its thread. Called after a snooze
 * write; a no-op (no write) when the thread already holds the right value, so
 * snoozing an older message of the thread never touches the thread row.
 */
export async function syncThreadLatestSnooze(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const next = await readLatestSnoozedUntil(ctx, thread);
	if (thread.latestSnoozedUntil === next) return;
	await ctx.db.patch(threadId, { latestSnoozedUntil: next });
}
