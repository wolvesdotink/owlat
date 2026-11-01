/**
 * `inboundMessages` fields for a message a newer message's sent reply
 * answered (inbox/answeredThread.ts) and for the response obligation a
 * bounce of that reply reopens (inbox/sla/threadClock.ts). Spread into the
 * table in ./inbox.ts, which is at its size cap.
 */

import { v } from 'convex/values';
import { pendingClarificationValidator } from '../lib/validators/clarification';

export const inboundAnsweredFields = {
	// Archived because the agent reply to a newer message of the thread was
	// sent (inbox/answeredThread.ts): what the agent had here, kept so a
	// bounce of that reply can restore it, purged after the retention window.
	answeredStash: v.optional(
		v.object({
			// The newer messages whose sent replies answered this one.
			byInboundMessageIds: v.array(v.id('inboundMessages')),
			// Moves with each distinct sent reply; past the tracking cap the set
			// stops growing and the message stays answered for good.
			at: v.number(),
			isUntracked: v.optional(v.literal(true)),
			processingStatus: v.union(
				v.literal('classifying'),
				v.literal('drafting'),
				v.literal('draft_ready'),
				v.literal('awaiting_clarification')
			),
			draftResponse: v.optional(v.string()),
			pendingClarification: v.optional(pendingClarificationValidator),
		})
	),
	// When the reply that had answered this message bounced and reopened it
	// (inbox/answeredThread.ts): a live response obligation, read by the
	// response clock (inbox/sla/threadClock.ts). Cleared when it ends: the
	// message needs no reply any more, or another sent reply settles it.
	answerBouncedAt: v.optional(v.number()),
};
