/**
 * In-state step-output mirrors — the mutations that persist an Agent step's
 * result onto its `inboundMessage` WITHOUT changing `processingStatus`.
 *
 * Split out of `./processingLifecycle.ts` (the status dispatcher) once that file
 * crossed the ~500 LOC size cap. These writers share one shape: an Agent
 * step (`context_retrieval` / `route` / `draft`) calls them after its execute()
 * completes, still inside its current processingStatus, so the review UI can
 * read the step's output. They are deliberately NOT part of `transition()`'s
 * atomic status write — they mirror read-side fields the router / UI consume and
 * change NO routing on their own. FAIL-SOFT: callers wrap these so a persistence
 * failure degrades to "no metadata shown" and never wedges the walker.
 *
 * The two guard-marker writers at the end (`recordSecurityScan`, `recordLateGuard`) are
 * the exception to "fail-soft": they store the `guardNotRun` marker and its
 * clearing, which later autonomous paths read, so their callers let a failure
 * surface.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internalQuery } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import {
	guardStanding,
	mergeLateGuard,
	type GuardStanding,
} from '../agent/steps/security_scan/disposition';
import {
	contextCoverageValidator,
	draftQualityValidator,
	groundingSourceValidator,
	securityFlagsValidator,
} from '../lib/convexValidators';
import { attachmentSuggestionsValidator } from '../lib/validators/attachment';
import { contextTierValidator } from '../lib/literalValidators';
import { authoredDraftHasGaps } from '../agent/shared/draftGaps';
import { NO_SAVED_EDITS } from './processingLifecycle/draftFields';
import { isAnsweredInThread } from './answeredThread';
import { dispatch } from './processingLifecycle/effects';
import { asTeamGapQuestion, checkDraftGaps } from '../mail/ai/gapQuestions';
import { hasUnconsentedOpenQuestion, hasUsableAnswer } from './clarificationAnswers';
import { UNASKABLE_GAP_REASON } from '../lib/heldGapDraft';
import type { MutationCtx } from '../_generated/server';

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
 * (`isDraftGapGuarded`), so a reviewer's Approve cannot send them. A new
 * draft starts without the saved edits of the one it replaces.
 *
 * WRITE-SIDE FENCE (#1343): a draft with gaps is stored only with the owner's
 * consent ("Draft with what I have" on the stored clarification, or the
 * caller's `isGapsAccepted`, which the draft step passes when asking is off).
 * Without it the draft is not stored, whoever wrote it: a draft action that
 * started before this rule finishes here too. Nor is any draft while a stored
 * question is still open without that consent. The open questions and the
 * draft's gaps go back to the owner as questions, or, when only a question
 * Owlat never asks could fill the gaps, the reply is left to a person with no
 * AI draft.
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
		// The draft was written cheap-first: never auto-sent.
		isCheapFirstDraft: v.optional(v.boolean()),
		// Standing consent to gaps (asking is turned off). The owner's own
		// "Draft with what I have" is read from the stored clarification.
		isGapsAccepted: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		// A person took the reply over while this draft was being written: their
		// text is the reply now, so the late agent draft is dropped.
		const message = await ctx.db.get(args.inboundMessageId);
		// Answered first: a message a newer sent reply answered never reaches the
		// gap hold below, nor the draft write (inbox/answeredThread.ts).
		if (!message || message.manualTakeoverAt !== undefined || isAnsweredInThread(message)) return;
		const hasGaps = authoredDraftHasGaps({ text: args.draftResponse });
		const isGapsAccepted =
			args.isGapsAccepted === true || message.pendingClarification?.isGapsAccepted === true;
		// A stored question still open without consent holds the draft too,
		// whatever its text: a draft that leaves the fact out is no better.
		const isQuestionOpen = hasUnconsentedOpenQuestion(message.pendingClarification, isGapsAccepted);
		if ((hasGaps && !isGapsAccepted) || isQuestionOpen) {
			await holdUnconsentedGapDraft(ctx, message, args.draftResponse);
			return;
		}
		await ctx.db.patch(args.inboundMessageId, {
			draftResponse: args.draftResponse,
			draftSubject: args.draftSubject,
			// A `[[...]]` placeholder marks a fact the agent did not have. Stored as
			// the gap guard, so the composer highlights and counts it and
			// `approveDraft` refuses to send it (DRAFT_HAS_GAPS) until it is filled.
			isDraftGapGuarded: hasGaps,
			// Gaps the owner agreed to: shown, highlighted (lib/heldGapDraft.ts).
			isDraftGapsAccepted: hasGaps ? true : undefined,
			confidenceScore: args.confidenceScore,
			...(args.draftQuality ? { draftQuality: args.draftQuality } : {}),
			// No screen offers variants any more (#1200): a new draft drops the ones
			// an earlier run left, which no longer match the draft.
			draftOptions: undefined,
			...(args.attachmentSuggestions ? { attachmentSuggestions: args.attachmentSuggestions } : {}),
			// Bound to this draft: set for a cheap-first draft, cleared by any other.
			isCheapFirstDraft: args.isCheapFirstDraft === true ? true : undefined,
			// Edits a person saved over an earlier draft are not edits of this
			// one: the next save seeds this draft as revision 0. (A Retry never
			// re-drafts over a person's reply, #1220.)
			...NO_SAVED_EDITS,
		});
	},
});

/**
 * The fence's hold (see `recordDraftOutput`): nothing of the draft is stored.
 * Only a message still in `drafting` moves; anywhere else the late draft is
 * simply dropped. Questions are written untranslated (a mutation cannot call
 * the model); the draft step's own hold translates them.
 */
async function holdUnconsentedGapDraft(
	ctx: MutationCtx,
	message: Doc<'inboundMessages'>,
	draft: string
): Promise<void> {
	if (message.processingStatus !== 'drafting') return;
	const existing = message.pendingClarification?.questions ?? [];
	const gaps = checkDraftGaps(draft, { fromAddress: message.from, existing });
	const fresh = gaps.kind === 'ask' ? gaps.questions.map(asTeamGapQuestion) : [];
	const at = Date.now();
	// Questions to ask: the stored ones still open, and one per new gap.
	if (fresh.length > 0 || !existing.every(hasUsableAnswer)) {
		await dispatch(ctx, message, {
			to: 'awaiting_clarification',
			at,
			pendingClarification: { questions: [...existing, ...fresh], askedAt: at },
		});
		return;
	}
	// Only a credential could fill the gap: a person writes the reply. Blocked
	// from autonomous sending too, since the route step may still run after.
	await ctx.db.patch(message._id, {
		isAutoSendBlocked: true,
		agentDecision: {
			decision: 'human_review',
			reason: UNASKABLE_GAP_REASON,
			confidence: message.confidenceScore ?? 0,
		},
	});
	await dispatch(ctx, message, { to: 'draft_ready', at, draftResponse: '' });
}

/**
 * Persist the scan of a message that arrived while the agent
 * was off. That path ends the run in `security_check` without a transition, so
 * before this its scan was never stored; now it carries the `guardNotRun` marker
 * every later autonomous consumer checks. Written only while the message is
 * still in `security_check` and nobody has taken it over, so a late write can
 * never overwrite a later scan or a person's reply.
 */
export const recordSecurityScan = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		securityFlags: securityFlagsValidator,
	},
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message || message.processingStatus !== 'security_check') return;
		if (message.manualTakeoverAt !== undefined) return;
		await ctx.db.patch(args.inboundMessageId, { securityFlags: args.securityFlags });
	},
});

/**
 * Record a model guard that ran late, the first time a generative
 * consumer reached a message whose scan skipped it (agent/steps/security_scan/
 * guard.ts `runGuardBeforeAutonomy`), and answer with the message's
 * AUTHORITATIVE standing, which the caller acts on instead of its own verdict.
 *
 * Late guards can overlap (extraction, interpretation, a briefing's history),
 * so the result is merged, never written over: `mergeLateGuard` is monotonic
 * within one scan generation (`scanTimestamp`), so a rejection that landed
 * first is kept and one that lands second still applies after a benign run
 * cleared the marker. A result for an older generation (the pipeline rescanned
 * the message meanwhile) is dropped, and the newer scan's standing answers. A
 * gone message answers `rejected`: nothing may read it. The processing status
 * is untouched.
 */
export const recordLateGuard = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		generation: v.number(),
		verdict: v.object({
			flagged: v.optional(v.object({ confidence: v.number(), reason: v.string() })),
			isIncomplete: v.boolean(),
		}),
	},
	handler: async (ctx, args): Promise<GuardStanding> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return 'rejected';
		const flags = message.securityFlags;
		if (!flags || flags.scanTimestamp !== args.generation) return guardStanding(message);
		const merged = mergeLateGuard(flags, args.verdict);
		await ctx.db.patch(args.inboundMessageId, { securityFlags: merged });
		return guardStanding({ ...message, securityFlags: merged });
	},
});

/**
 * Guard placement: where a Team message stands before thread interpretation reads
 * it (agent/steps/security_scan/disposition.ts `guardStanding`). The message
 * rides along only when its guard still has to run, so the caller can run it.
 */
export const guardStandingOf = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (
		ctx,
		args
	): Promise<
		| { standing: 'rejected' | 'clear' }
		| { standing: 'needs_guard'; message: Doc<'inboundMessages'> }
	> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return { standing: 'clear' };
		const standing = guardStanding(message);
		return standing === 'needs_guard' ? { standing, message } : { standing };
	},
});
