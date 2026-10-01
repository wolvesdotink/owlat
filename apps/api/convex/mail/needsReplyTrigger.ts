/**
 * The Reply Queue row's trigger fields (plan C8).
 *
 * `applyResult` copies the trigger message's sender, subject and arrival time
 * onto the needs-reply flag (`needsReply.trigger`), so `listQueue` can serve a
 * row from the thread document alone instead of loading one message per row.
 * Flags written before the copy existed have no `trigger`; the read falls back
 * to the message and `migrations/0047_denormalize_thread_rows` backfills them.
 *
 * Not a Convex function; helpers shared by `mail/needsReply.ts` and the
 * migration. Kept out of `needsReply.ts` for the domain-file size cap.
 */

import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { isThreadLatestSnoozed } from './threadLatestSnooze';

type NeedsReplyFlag = NonNullable<Doc<'mailThreads'>['needsReply']>;
export type NeedsReplyTrigger = NonNullable<NeedsReplyFlag['trigger']>;

/** The trigger message fields a Reply Queue row shows, as stored on the flag. */
export function needsReplyTriggerOf(message: Doc<'mailMessages'>): NeedsReplyTrigger {
	return {
		fromAddress: message.fromAddress,
		...(message.fromName !== undefined ? { fromName: message.fromName } : {}),
		subject: message.subject,
		receivedAt: message.receivedAt,
	};
}

/**
 * A flagged thread's trigger fields, or null when the row must not show
 * (trigger message gone, or snoozed). Plan C8: when the trigger is the thread's
 * newest message (the usual case) both answers come off the thread row: the
 * copied `trigger` fields and `latestSnoozedUntil`. Every path that deletes a
 * message from a live mailbox rebuilds its thread's aggregates (purge, trash
 * retention, IMAP expunge; the others delete the whole mailbox), so a trigger
 * that is still `latestMessageId` still exists. Any other case loads the
 * message, as before.
 */
export async function readQueueTrigger(
	ctx: QueryCtx,
	thread: Doc<'mailThreads'>,
	flag: NeedsReplyFlag,
	now: number
): Promise<NeedsReplyTrigger | null> {
	if (flag.trigger && flag.messageId === thread.latestMessageId) {
		return (await isThreadLatestSnoozed(ctx, thread, now)) ? null : flag.trigger;
	}
	const message = await ctx.db.get(flag.messageId);
	// Snoozed = deliberately deferred; it re-enters the queue on wakeup.
	if (!message || isMessageSnoozed(message, now)) return null;
	return needsReplyTriggerOf(message);
}
