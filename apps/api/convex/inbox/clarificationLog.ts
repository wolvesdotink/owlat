/**
 * Clarification ask-outcome logging — the write seam for the `clarificationAskLog`
 * table (see schema/inbox.ts). One row per clarifying ask, carrying the cheap
 * PREDICTED value of the ask and, where the answer→draft delta is sampled,
 * whether the owner's answer actually CHANGED the produced draft.
 *
 * Two call sites, both fail-soft (a logging failure must never block ingest,
 * the walker, or a draft):
 *   - the inbound agent `clarify` step logs the ask it surfaced (source 'agent'),
 *   - the Reply-Queue draft path logs the measured outcome (source 'reply_queue').
 *
 * Pure observability — nothing here influences routing or auto-send.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';

/**
 * Persist one clarification ask-outcome row. All measurement fields are optional
 * so both call sites use the same writer: the agent step logs the ask + its
 * predicted value at emit time; the Reply-Queue path additionally logs the
 * sampled draft-with vs draft-without divergence once the owner answers.
 */
export const recordClarificationAsk = internalMutation({
	args: {
		source: v.union(v.literal('agent'), v.literal('reply_queue')),
		slotTypes: v.array(v.string()),
		questionCount: v.number(),
		predictedValue: v.number(),
		eagerness: v.optional(v.string()),
		threadId: v.optional(v.id('mailThreads')),
		isDraftChanged: v.optional(v.boolean()),
		draftDivergence: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await ctx.db.insert('clarificationAskLog', {
			source: args.source,
			slotTypes: args.slotTypes,
			questionCount: args.questionCount,
			predictedValue: args.predictedValue,
			eagerness: args.eagerness,
			threadId: args.threadId,
			isDraftChanged: args.isDraftChanged,
			draftDivergence: args.draftDivergence,
			createdAt: Date.now(),
		});
	},
});
