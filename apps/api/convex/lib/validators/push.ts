/**
 * Validators for Web Push (`push/`): the event a producer hands the sender.
 *
 * One home because the producers (mail delivery, inbox assignment, chat) and
 * the scheduled sender all speak this shape, and a scheduled job keeps the
 * arguments it was queued with across a deploy.
 */

import { v } from 'convex/values';

/**
 * What happened, by reference only: the sender re-reads the row when it runs,
 * so a message read, deleted or muted in the meantime never notifies, and no
 * content sits in the scheduler's argument log.
 */
export const pushEventValidator = v.union(
	// New mail landed in the inbox of a personal mailbox.
	v.object({ kind: v.literal('mail'), messageId: v.id('mailMessages') }),
	// A shared-inbox thread was handed to this person (or the agent asked them).
	v.object({ kind: v.literal('assignment'), noticeId: v.id('inboxAssignmentNotices') }),
	// A chat message that @-mentions this person, or a direct message to them.
	v.object({
		kind: v.literal('chat'),
		messageId: v.id('chatMessages'),
		reason: v.union(v.literal('mention'), v.literal('dm')),
	}),
	// "Send a test notification" from Preferences, to one device.
	v.object({ kind: v.literal('test'), subscriptionId: v.id('pushSubscriptions') })
);
