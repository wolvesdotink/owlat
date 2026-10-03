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
import { internalMutation } from '../lib/writeFence';
import {
	contextCoverageValidator,
	draftQualityValidator,
	groundingSourceValidator,
} from '../lib/convexValidators';
import { attachmentSuggestionsValidator } from '../lib/validators/attachment';
import { contextTierValidator } from '../lib/literalValidators';
import { authoredDraftHasGaps } from '../agent/shared/draftGaps';

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
		contextTier: contextTierValidator,
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
		// Taken over mid-route: no agent decision was acted on, so none is shown.
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message || message.manualTakeoverAt !== undefined) return;
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
 * decision. A draft with `[[...]]` placeholders is stored gap-guarded
 * (`isDraftGapGuarded`), so a reviewer's Approve cannot send them.
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
		// Deprecated (#1200), accepted and ignored: the draft step no longer
		// generates variants, but an action started before that deploy may still
		// pass them. Remove in the release after.
		draftOptions: v.optional(v.array(v.string())),
		// Advisory attachment suggestion (see lib/validators/attachment.ts). Absent unless
		// the inbound asked for a document and a contact-scoped file matched.
		attachmentSuggestions: v.optional(attachmentSuggestionsValidator),
	},
	handler: async (ctx, args) => {
		// A person took the reply over while this draft was being written: their
		// text is the reply now, so the late agent draft is dropped.
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message || message.manualTakeoverAt !== undefined) return;
		await ctx.db.patch(args.inboundMessageId, {
			draftResponse: args.draftResponse,
			draftSubject: args.draftSubject,
			// A `[[...]]` placeholder marks a fact the agent did not have. Stored as
			// the gap guard, so the composer highlights and counts it and
			// `approveDraft` refuses to send it (DRAFT_HAS_GAPS) until it is filled.
			isDraftGapGuarded: authoredDraftHasGaps({ text: args.draftResponse }),
			confidenceScore: args.confidenceScore,
			...(args.draftQuality ? { draftQuality: args.draftQuality } : {}),
			// No screen offers variants any more (#1200): a new draft drops the ones
			// an earlier run left, which no longer match the draft.
			draftOptions: undefined,
			...(args.attachmentSuggestions ? { attachmentSuggestions: args.attachmentSuggestions } : {}),
		});
	},
});
