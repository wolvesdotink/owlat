import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Which messages carry which label, as rows an index can range over
 * (`mail/labelMessageIndex.ts`). `mailMessages.labelIds` is an array, and a
 * Convex index over an array matches whole-array equality only, so without
 * these rows the label view and "does any message of this thread still carry
 * the label" can only read messages and test the array.
 *
 * `mailLabelMessages` holds one row per (message, label) pair, written in the
 * same transaction as the message's `labelIds`. `mailLabelMembership` is one
 * row per mailbox: once `isReady`, the rows hold every pair of that mailbox and
 * readers may use them. A mailbox without a ready row keeps the message scans.
 *
 * Derived data: rebuilt by `migrations/0073_backfill_label_membership`, deleted
 * with each message (`deleteMessageRowAndBlobs`) and with the mailbox, and swept
 * with the workspace.
 *
 * Spread into `mailTables` from schema/mail.ts.
 */
export const mailLabelMembershipTables = {
	mailLabelMembership: defineTable({
		mailboxId: v.id('mailboxes'),
		/** Every (message, label) pair of the mailbox has its row. */
		isReady: v.boolean(),
		/** Backfill page cursor over `by_mailbox_and_received`; null before page 1 and once ready. */
		cursor: v.union(v.string(), v.null()),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		updatedAt: v.number(),
	}).index('by_mailbox', ['mailboxId']),

	mailLabelMessages: defineTable({
		mailboxId: v.id('mailboxes'),
		labelId: v.id('mailLabels'),
		messageId: v.id('mailMessages'),
		threadId: v.id('mailThreads'),
		/** The message's `receivedAt`, which no write changes after insert. */
		receivedAt: v.number(),
	})
		// The label view, newest first.
		.index('by_mailbox_and_label_and_received', ['mailboxId', 'labelId', 'receivedAt'])
		// "Does any message of this thread still carry the label".
		.index('by_thread_and_label', ['threadId', 'labelId'])
		.index('by_message_and_label', ['messageId', 'labelId']),
};
