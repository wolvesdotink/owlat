/**
 * In-state step-output mirrors — the mutations that persist an Agent step's
 * result onto its `inboundMessage` WITHOUT changing `processingStatus`.
 *
 * Split out of `./processingLifecycle.ts` (the status dispatcher) once that file
 * crossed the ~500 LOC size cap. These three writers share one shape: an Agent
 * step (`context_retrieval` / `route` / `draft`) calls them after its execute()
 * completes, still inside its current processingStatus, so the review UI can
 * read the step's output. They are deliberately NOT part of `transition()`'s
 * atomic status write — they mirror read-side fields the router / UI consume and
 * change NO routing on their own. FAIL-SOFT: callers wrap these so a persistence
 * failure degrades to "no metadata shown" and never wedges the walker.
 *
 * See docs/adr/0010-inbox-processing-lifecycle-module.md and
 * docs/adr/0014-agent-step-module.md.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import {
	contextCoverageValidator,
	draftQualityValidator,
	groundingSourceValidator,
} from '../lib/convexValidators';
import { attachmentSuggestionsValidator } from './attachmentValidators';

/**
 * Record the context-tier metadata onto an inboundMessage without
 * changing its processingStatus. Used by the `context_retrieval`
 * Agent step (module) after its execute completes (still in
 * `classifying` state).
 *
 * Also persists the ADVISORY retrieval-coverage / grounding signal
 * (which briefing legs were populated, knowledge-hit count, top score,
 * derived low-coverage). Coverage is optional so callers that only have
 * a tier still work; it changes NO routing today.
 */
export const recordContextTier = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		contextTier: v.union(v.literal('normal'), v.literal('compacted'), v.literal('emergency')),
		contextCoverage: v.optional(contextCoverageValidator),
		// The prior emails + knowledge entries actually assembled into the
		// briefing — read-side provenance for the review UI. Optional so callers
		// that only have a tier still work; changes NO routing.
		groundingSources: v.optional(v.array(groundingSourceValidator)),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.inboundMessageId, {
			contextTier: args.contextTier,
			...(args.contextCoverage ? { contextCoverage: args.contextCoverage } : {}),
			...(args.groundingSources ? { groundingSources: args.groundingSources } : {}),
		});
	},
});

/**
 * Record the router's decision + reason + confidence onto an inboundMessage
 * WITHOUT changing its processingStatus. Called by the `route` Agent step so the
 * review UI can explain WHY a message was auto-sent or held ("Sent because… /
 * Held because…"). This is a READ-SIDE MIRROR of the decision the route step
 * already made — the actual auto-send vs human-review transition is still driven
 * by the step's `route()` result, unchanged. FAIL-SOFT: the route step wraps
 * this call so a persistence failure degrades to "no explanation shown" and
 * never wedges the walker.
 */
export const recordAgentDecision = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		decision: v.union(v.literal('auto_approve'), v.literal('human_review')),
		reason: v.string(),
		confidence: v.number(),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.inboundMessageId, {
			agentDecision: {
				decision: args.decision,
				reason: args.reason,
				confidence: args.confidence,
			},
		});
	},
});

/**
 * Record the agent's generated draft onto an inboundMessage without
 * changing its processingStatus. Used by the `draft` Agent step
 * (module) after its execute completes (still in `drafting` state).
 * The next step (`route`) reads the stored fields to make its routing
 * decision.
 */
export const recordDraftOutput = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		draftResponse: v.string(),
		draftSubject: v.string(),
		confidenceScore: v.number(),
		// Draft-quality self-check result — persisted SEPARATELY from the
		// classifier confidenceScore. Optional: absent when the self-check
		// LLM call failed (the route step then treats quality as unknown/LOW).
		draftQuality: v.optional(draftQualityValidator),
		// Optional 2–3 pickable draft variants offered at the review gate (only
		// on low-confidence / low-quality cases). `draftOptions[0]` mirrors
		// `draftResponse`. Absent on the normal single-draft path.
		draftOptions: v.optional(v.array(v.string())),
		// Advisory attachment suggestion (see attachmentValidators). Absent unless
		// the inbound asked for a document and a contact-scoped file matched.
		attachmentSuggestions: v.optional(attachmentSuggestionsValidator),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch(args.inboundMessageId, {
			draftResponse: args.draftResponse,
			draftSubject: args.draftSubject,
			confidenceScore: args.confidenceScore,
			...(args.draftQuality ? { draftQuality: args.draftQuality } : {}),
			...(args.draftOptions ? { draftOptions: args.draftOptions } : {}),
			...(args.attachmentSuggestions
				? { attachmentSuggestions: args.attachmentSuggestions }
				: {}),
		});
	},
});
