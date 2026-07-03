/**
 * Post-send outcome feedback
 *
 * Captures REAL-WORLD post-send outcomes (angry replies / bounces / complaints,
 * and unedited answered-clarification sends) as autonomy feedback, so the
 * self-tuning loop stays calibrated as auto-send volume grows — outcomes on
 * messages the human never reviewed still tune the thresholds and feed the
 * rejection-spike circuit breaker.
 *
 * Split out of `autonomy.ts` to keep that module under the file-size ratchet;
 * the recorded rows are plain `autonomyFeedback` rows written through the same
 * `internal.autonomy.recordFeedback` writer the human path uses.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

/**
 * The real-world post-send outcome signals that can be captured for a message
 * that was AUTO-sent (or, for the positive clarification case, sent by the
 * owner unedited). Each maps deterministically to an `autonomyFeedback.action`
 * so the existing threshold-adjustment cron and rejection-spike circuit breaker
 * consume them unchanged — an angry reply / bounce / complaint reads as a
 * `rejected`, an unedited answered-clarification send as an `approved`.
 */
export const OUTCOME_SIGNAL = {
	reply_negative: 'rejected',
	bounce: 'rejected',
	complaint: 'rejected',
	clarification_unedited_send: 'approved',
} as const;

export type OutcomeSignal = keyof typeof OUTCOME_SIGNAL;

const outcomeSignalValidator = v.union(
	v.literal('reply_negative'),
	v.literal('bounce'),
	v.literal('complaint'),
	v.literal('clarification_unedited_send'),
);

/**
 * Record a real-world post-send OUTCOME as autonomy feedback, attributed to the
 * ORIGINAL auto-sent message's category/sender (not the reply's). This is the
 * second signal source that keeps the self-tuning loop calibrated as auto-send
 * volume grows: outcomes on messages the human never reviewed still tune the
 * thresholds and feed the rejection-spike breaker.
 *
 * Fail-soft and conservative:
 *   - a missing original message is a no-op (nothing to attribute to);
 *   - the category comes from the original message's classification (`other`
 *     when unclassified), so the signal always lands somewhere;
 *   - the caller only ever passes a signal it is CONFIDENT about — a neutral
 *     reply is filtered out UPSTREAM (see agent/outcomeFeedback), never here.
 */
export const recordOutcomeFeedback = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		signal: outcomeSignalValidator,
	},
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return; // original message gone — nothing to attribute

		const category = message.classification?.category ?? 'other';
		const action = OUTCOME_SIGNAL[args.signal as OutcomeSignal];
		const agentConfidence =
			message.confidenceScore ?? message.classification?.confidence ?? 0;

		await ctx.runMutation(internal.autonomy.recordFeedback, {
			category,
			action,
			agentConfidence,
			userFeedback: `post-send outcome: ${args.signal}`,
			inboundMessageId: args.inboundMessageId,
			source: 'outcome',
			outcomeSignal: args.signal,
		});
	},
});

/**
 * Load the fields the outcome-classification action needs about a prior
 * auto-sent message: whether it was actually AUTO-sent (so a human-reviewed
 * send is never mislabeled) and the linked original message id. Session-less
 * — consumed by the `agent/outcomeFeedback` node action.
 */
export const getReplyOutcomeContext = internalQuery({
	args: { replyMessageId: v.id('inboundMessages') },
	handler: async (
		ctx,
		args,
	): Promise<{ wasAutoSent: boolean; originalMessageId: Id<'inboundMessages'> } | null> => {
		const reply = await ctx.db.get(args.replyMessageId);
		if (!reply?.threadId) return null;

		// Find the most recent PRIOR message on the thread that the agent
		// AUTO-sent (route step's `auto_approve` decision that reached `sent`).
		// Scan newest-first and stop at the first auto-sent original.
		const priors = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', reply.threadId))
			.order('desc')
			.take(50);

		for (const prior of priors) {
			if (prior._id === reply._id) continue;
			if (prior.receivedAt >= reply.receivedAt) continue; // must precede the reply
			if (
				prior.processingStatus === 'sent' &&
				prior.agentDecision?.decision === 'auto_approve'
			) {
				return { wasAutoSent: true, originalMessageId: prior._id };
			}
		}
		return null;
	},
});
