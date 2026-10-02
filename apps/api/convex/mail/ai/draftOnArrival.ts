'use node';

/**
 * Personal-mail draft-on-arrival (postbox.aiDraft).
 *
 * When a personal Postbox message that needs a reply lands (or a clarification
 * is answered), pre-generate a reply into the thread's Reply Queue review slot
 * via the SHARED draft service (agent/shared/draftService.ts) — the exact same
 * code path the B2B inbound agent runs — so the OWNER's own inbox gets
 * draft-on-arrival + a confidence/quality signal, reviewed-and-sent by a human.
 *
 * FAIL-SOFT and HUMAN-REVIEW-ONLY end to end:
 *   - AI disabled / no provider / any generation error  → no slot written, the
 *     plain needs-reply row still renders (today's behaviour).
 *   - The slot's presence NEVER auto-sends — it only pre-fills the composer.
 *   - Prompt-injection in the assembled context throws inside the shared
 *     service; we swallow it here so the thread still shows for manual reply.
 */

import { v } from 'convex/values';
import { internalAction, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { buildReplySubject } from '../../lib/emailAddress';
import { logError } from '../../lib/runtimeLog';
import { recordLlmSpend } from '../../analytics/llmUsage';
import { buildConfirmedContext, runSharedDraft } from '../../agent/shared/draftService';
import { buildOpenFileNote, joinConfirmedBlocks } from '../../inbox/clarificationAnswers';
import { ensureGapPlaceholders } from './composeDraftPolicy';
import { formatVoiceSection, loadVoiceGuidance } from './voiceGuidance';

/** Map the personal-mail urgency bucket onto the shared draft block's priority vocabulary. */
function priorityForUrgency(urgency: 'high' | 'normal' | 'low'): string {
	if (urgency === 'high') return 'high';
	if (urgency === 'low') return 'low';
	return 'medium';
}

/** Fallback confidence shown next to a draft when the quality self-check failed. */
const UNKNOWN_QUALITY_CONFIDENCE = 0.4;

/**
 * Handler body, exported so the fail-soft branches (AI off, no thread, injection
 * / LLM error → no slot written) are unit-testable with a mock ctx without
 * standing up Convex. The `generateForThread` internalAction below is a thin
 * wrapper.
 */
export async function generateDraftOnArrival(
	ctx: ActionCtx,
	args: { threadId: Id<'mailThreads'> }
): Promise<void> {
	// Defense-in-depth: refuse if the AI stack is off, even though the schedule
	// site already flag-gated. assertAiAllowed throws when AI is disabled; that
	// (and every other failure below) degrades to no slot.
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
	} catch {
		return;
	}

	const loaded = await ctx.runQuery(internal.mail.ai.draftOnArrivalStore.loadForDraft, {
		threadId: args.threadId,
	});
	if (!loaded) return; // not a live needs-reply personal-mail thread

	// Personalize to the owner's learned writing voice (opt-in, fail-soft). No
	// access check: a scheduled internal action for the thread's own mailbox.
	const voiceSection = formatVoiceSection(
		await loadVoiceGuidance(ctx, { mailboxId: loaded.mailboxId, requireAccess: false })
	);

	// Owner-confirmed clarification facts (trusted; rendered outside the
	// untrusted tags by the shared service), and the files the clarification
	// card still waits for, which the draft must not claim to attach.
	const confirmedContext = joinConfirmedBlocks(
		buildConfirmedContext(
			loaded.clarificationQuestions ? { questions: loaded.clarificationQuestions } : undefined
		),
		buildOpenFileNote(loaded.fileGaps)
	);

	try {
		const result = await runSharedDraft(ctx, {
			surface: 'personal',
			resolveModel: () => resolveLanguageModel(ctx, 'draft'), // capable tier, lazy for custom strategies
			// Name the owner's address so the model knows which side of the
			// labelled transcript it writes for (loadForDraft marks both sides).
			audience: `the mailbox owner (${loaded.ownerAddress}), answering the last message in the thread, which the other party sent`,
			styleReference: "the owner's",
			context: loaded.context,
			confirmedContext: confirmedContext.length > 0 ? confirmedContext : undefined,
			classification: {
				// person / newsletter → the shared block's neutral vocabulary.
				category: 'other',
				intent: 'question',
				sentiment: 'neutral',
				priority: priorityForUrgency(loaded.urgency),
			},
			toneInstruction:
				'\n\nTone: match the owner’s natural, personal style — warm and direct, not corporate.',
			signatureInstruction: '',
			voiceSection,
			// Personal mail has no classifier confidence; run review-first so the
			// shared service offers alternative drafts. The confidence SHOWN is the
			// quality self-check score (below), not this gating value.
			confidence: 0.5,
			spendLabels: {
				selfCheck: 'postbox_draft_selfcheck',
				options: 'postbox_draft_options',
			},
			strategyScope: { mailboxId: loaded.mailboxId, classification: 'other' },
		});

		// The primary generation is the costliest call on this path, and it was
		// the one call that recorded no spend: usage showed the self-check and
		// options labels but never the draft itself.
		await recordLlmSpend(ctx, 'postbox_draft', result.tokenUsage, result.modelUsed);

		if (result.draftBody.trim().length === 0) return; // nothing usable
		// The alternatives are written without the trusted block, so with files
		// outstanding they could say "attached"; only the primary draft is kept.
		const options = loaded.fileGaps.length === 0 ? result.draftOptions : [];

		await ctx.runMutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId: args.threadId,
			triggerMessageId: loaded.triggerMessageId,
			draft: ensureGapPlaceholders(result.draftBody, loaded.fileGaps),
			draftSubject: buildReplySubject(loaded.triggerSubject),
			// Surface the quality self-check score as the confidence; unknown
			// quality shows a deliberately low value so review-first reads right.
			confidence: result.draftQuality?.score ?? UNKNOWN_QUALITY_CONFIDENCE,
			...(result.draftQuality ? { quality: result.draftQuality } : {}),
			...(options.length > 0 ? { options } : {}),
		});
	} catch (err) {
		// Injection re-scan / LLM error → no slot; the thread still shows for
		// manual reply. Never wedge the caller.
		logError('[draftOnArrival] generation failed:', err);
	}
}

export const generateForThread = internalAction({
	args: { threadId: v.id('mailThreads') },
	handler: (ctx, args) => generateDraftOnArrival(ctx, args),
});
