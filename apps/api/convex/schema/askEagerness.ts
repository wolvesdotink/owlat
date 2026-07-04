import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Ask-eagerness tables — the trust dial setting and its ask-outcome log.
 *
 * Split out of `schema/inbox.ts` so that file stays under the file-size ratchet.
 * Conceptually these sit ALONGSIDE the per-category autonomy rules: eagerness
 * decides when Owlat should stop and ask, autonomy decides when it may act. The
 * persistence surface is `inbox/askEagernessSettings.ts`; the pure policy +
 * instrumentation helpers are `inbox/askEagerness.ts`.
 */
export const askEagernessTables = {
	// Ask-eagerness setting - the single global "how readily should Owlat stop
	// and ask me a clarifying question" trust dial, stored ALONGSIDE the
	// per-category autonomy rules so the two read as one coherent control (see
	// inbox/askEagerness.ts). Single-row (single-org deployment); absent row =
	// today's behaviour (never a silent default). `mode` is validated to an
	// EagernessMode on read.
	askEagernessSettings: defineTable({
		mode: v.string(), // 'cautious' | 'balanced' | 'confident' | 'off'
		updatedAt: v.number(),
	}),

	// Clarification ask-outcome log - one row per clarifying ask, carrying the
	// cheap PREDICTED value of asking and, once the owner answers, whether the
	// answer actually CHANGED the produced draft (draft-with vs draft-without
	// divergence, sampled cheaply). Feeds calibration of the eagerness dial: are
	// the asks we predicted valuable the ones that actually moved the draft?
	// Never drives routing.
	clarificationAskLog: defineTable({
		source: v.union(v.literal('agent'), v.literal('reply_queue')),
		slotTypes: v.array(v.string()), // the slot kinds asked about
		questionCount: v.number(),
		predictedValue: v.number(), // cheap predicted value of asking, [0, 1]
		eagerness: v.optional(v.string()), // dial position at ask time, if any
		threadId: v.optional(v.id('mailThreads')),
		// Filled once the answer lands and a draft is produced:
		isDraftChanged: v.optional(v.boolean()), // answer materially changed the draft
		draftDivergence: v.optional(v.number()), // 1 - similarity, when sampled
		createdAt: v.number(),
	}).index('by_created_at', ['createdAt']),
};
