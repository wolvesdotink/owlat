import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Team inbox FOLLOW-UPS — a person writing to the customer again on a thread
 * whose latest message was already answered.
 *
 * An inbound message carries exactly one reply: its `draftResponse` rides the
 * processing lifecycle to `sent`, which is terminal. A second message from the
 * team has nothing on that lifecycle to ride, so it gets its own row and its
 * own small lifecycle (`inbox/followUps.ts`, the only writer of `status`):
 *
 *   scheduled ──(undo window elapses)──▶ sending ──▶ sent
 *       │                                   └──────▶ failed
 *       └──(Undo)──▶ cancelled
 *
 * `scheduled` holds the human-approve undo window (the same
 * `agentConfig.humanApproveUndoDelayMs` an approved draft waits out); a 0
 * window goes straight to dispatch. `sending` means a `team_reply` Send row
 * exists (`sendId`); the Send lifecycle drives the terminal edge once the
 * worker outcome lands.
 *
 * No cascade: a follow-up lives as long as its thread's history does.
 *
 * Spread into `defineSchema()` from schema.ts via `...inboxFollowUpTables`.
 */
export const inboxFollowUpTables = {
	inboxFollowUps: defineTable({
		threadId: v.id('conversationThreads'),
		// SNAPSHOT — the inbound message the follow-up answers (the thread's
		// newest at send time): its sender is the recipient, its Message-ID the
		// In-Reply-To.
		inReplyToMessageId: v.id('inboundMessages'),
		subject: v.string(),
		body: v.string(),
		status: v.union(
			v.literal('scheduled'),
			v.literal('sending'),
			v.literal('sent'),
			v.literal('failed'),
			v.literal('cancelled')
		),
		// BetterAuth user id of the person who wrote it.
		createdBy: v.string(),
		createdAt: v.number(),
		// When the undo window closes and the send leaves.
		sendAt: v.number(),
		// The scheduled dispatch, cancelled by Undo. Absent once dispatched.
		scheduledFnId: v.optional(v.id('_scheduled_functions')),
		// The `team_reply` Send carrying it, set on `sending`.
		sendId: v.optional(v.id('transactionalSends')),
		sentAt: v.optional(v.number()),
		errorMessage: v.optional(v.string()),
	}).index('by_thread', ['threadId']),
};
