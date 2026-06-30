/**
 * Knowledge-graph edge decay maintenance.
 *
 * We do NOT time-decay edge confidence in general: a deterministic or
 * human-authored edge is as true a year on as the day it was drawn, and an
 * LLM-inferred edge that cleared the inference floor (`tagForInferredConfidence`
 * → 'inferred') is trusted. The one exception is the long tail of low-confidence
 * LLM guesses tagged `'ambiguous'` — surfaced cautiously at construction and, if
 * nothing has reinforced them, just noise the graph should shed.
 *
 * "Reinforced" is handled by the merge rule, not here: when a stronger edge
 * merges into an ambiguous one, {@link mergeEdgeAttrs} keeps the stronger tag, so
 * the edge leaves the `'ambiguous'` set entirely and is never seen by the reaper.
 * What's left under the tag is genuinely unreinforced, so the reaper keys purely
 * on age (`createdAt`).
 *
 * This is system maintenance scheduled by a 24h cron (crons.ts) — it never feeds
 * an AI context, so it satisfies the `check-graph-scope.sh` rule (a) for reading
 * `knowledgeRelations` directly (the file is pre-allowlisted there).
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';

/**
 * How long a low-confidence, LLM-inferred (`confidenceTag: 'ambiguous'`,
 * `provenance: 'llm'`) edge is kept before being reaped. 30 days — long enough
 * for a real connection to be reinforced (which upgrades its tag out of the
 * reaping set), short enough that stale guesses don't accumulate.
 */
export const AMBIGUOUS_EDGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Edges scanned per reaping page — bounds the per-mutation transaction. */
const REAP_PAGE = 200;

/**
 * Reap stale ambiguous LLM-inferred edges: paginate the `by_confidence_tag`
 * index for `'ambiguous'` and delete those that are BOTH `provenance: 'llm'` AND
 * older than {@link AMBIGUOUS_EDGE_TTL_MS}. inferred / extracted / manual edges
 * (and ambiguous edges from a non-LLM provenance) are never reaped here.
 *
 * Self-reschedules to the next page until the index is drained, so one cron tick
 * sweeps the whole table without any single mutation doing unbounded work.
 */
export const reapAmbiguousEdges = internalMutation({
	args: {
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const cutoff = Date.now() - AMBIGUOUS_EDGE_TTL_MS;

		const page = await ctx.db
			.query('knowledgeRelations')
			.withIndex('by_confidence_tag', (q) => q.eq('confidenceTag', 'ambiguous'))
			.paginate({ cursor: args.cursor ?? null, numItems: REAP_PAGE });

		let reaped = 0;
		for (const edge of page.page) {
			if (edge.provenance === 'llm' && edge.createdAt < cutoff) {
				await ctx.db.delete(edge._id);
				reaped++;
			}
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.knowledge.relationDecay.reapAmbiguousEdges, {
				cursor: page.continueCursor,
			});
		}

		return { reaped, examined: page.page.length, done: page.isDone };
	},
});
