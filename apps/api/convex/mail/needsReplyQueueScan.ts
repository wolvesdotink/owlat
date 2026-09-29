/**
 * The rows the Reply Queue shows, before they are shaped into cards (plan 2.11).
 *
 * `listQueue` builds a card per row; `countQueue` only counts them, for the
 * shell's Answer badge. Both walk the same two indexes with the same filters,
 * so the badge and the list the Answer page shows can never disagree. Only the
 * list pays for what a card needs on top: the follow-up counterpart's display
 * name (a contact lookup plus up to three message scans per row).
 *
 * Not a Convex function; kept out of `needsReply.ts` for the domain-file size
 * cap.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { isThreadMuted } from '../lib/mailMute';
import { readQueueTrigger, type NeedsReplyTrigger } from './needsReplyTrigger';

/** Rows read per index; the queue shows at most this many of each kind. */
export const QUEUE_LIMIT = 100;

type Thread = Doc<'mailThreads'>;

export interface NeedsReplyQueueRow {
	thread: Thread;
	flag: NonNullable<Thread['needsReply']>;
	trigger: NeedsReplyTrigger;
}

export interface FollowUpQueueRow {
	thread: Thread;
	flag: NonNullable<Thread['followUp']> & { dueAt: number };
	message: Doc<'mailMessages'>;
}

/**
 * The mailbox's visible queue rows, newest first per kind: flagged threads
 * whose trigger still exists and is not snoozed, and sent mail whose follow-up
 * deadline passed. Muted threads are skipped in both.
 */
export async function scanReplyQueue(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	now: number
): Promise<{ needsReply: NeedsReplyQueueRow[]; followUps: FollowUpQueueRow[] }> {
	const flagged = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_needs_reply', (q) =>
			q.eq('mailboxId', mailboxId).gt('needsReply.detectedAt', 0)
		)
		.order('desc')
		.take(QUEUE_LIMIT);
	const needsReply: NeedsReplyQueueRow[] = [];
	for (const thread of flagged) {
		const flag = thread.needsReply;
		// Muted (mail/mute.ts) = the owner opted out of the conversation.
		if (!flag || isThreadMuted(thread)) continue;
		const trigger = await readQueueTrigger(ctx, thread, flag, now);
		if (trigger) needsReply.push({ thread, flag, trigger });
	}

	// Follow-up items: sent mail whose "remind me if no reply" deadline passed
	// (mail/followUps.ts sweep stamped followUp.dueAt). Deterministic; cleared
	// by any inbound reply or the cancel/dismiss mutation.
	const due = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_follow_up_due', (q) =>
			q.eq('mailboxId', mailboxId).gt('followUp.dueAt', 0)
		)
		.order('desc')
		.take(QUEUE_LIMIT);
	const followUps: FollowUpQueueRow[] = [];
	for (const thread of due) {
		const flag = thread.followUp;
		if (!flag || flag.dueAt === undefined || isThreadMuted(thread)) continue;
		const message = await ctx.db.get(flag.messageId);
		if (!message || isMessageSnoozed(message, now)) continue;
		followUps.push({ thread, flag: { ...flag, dueAt: flag.dueAt }, message });
	}
	return { needsReply, followUps };
}
