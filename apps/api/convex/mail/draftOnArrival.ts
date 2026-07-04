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
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { getLLMProvider } from '../lib/llmProvider';
import { buildReplySubject } from '../lib/emailAddress';
import { logError } from '../lib/runtimeLog';
import { buildConfirmedContext, runSharedDraft } from '../agent/shared/draftService';

/** Map the personal-mail urgency bucket onto the shared draft block's priority vocabulary. */
function priorityForUrgency(urgency: 'high' | 'normal' | 'low'): string {
	if (urgency === 'high') return 'high';
	if (urgency === 'low') return 'low';
	return 'medium';
}

/** Fallback confidence shown next to a draft when the quality self-check failed. */
const UNKNOWN_QUALITY_CONFIDENCE = 0.4;

export const generateForThread = internalAction({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		// Defense-in-depth: refuse if the AI stack is off, even though the schedule
		// site already flag-gated. assertAiAllowed throws when AI is disabled; that
		// (and every other failure below) degrades to no slot.
		try {
			await ctx.runMutation(internal.mail.aiGate.assertAiAllowed, {});
		} catch {
			return;
		}

		const loaded = await ctx.runQuery(internal.mail.draftOnArrivalStore.loadForDraft, {
			threadId: args.threadId,
		});
		if (!loaded) return; // not a live needs-reply personal-mail thread

		// Personalize to the owner's learned writing voice (opt-in). FAIL-SOFT: a
		// missing/disabled profile falls through to the generic tone.
		let voiceGuidance: string | null = null;
		try {
			const res = await ctx.runMutation(internal.mail.voiceProfile.getGuidanceForMailbox, {
				mailboxId: loaded.mailboxId,
			});
			voiceGuidance = res.guidance;
		} catch {
			voiceGuidance = null;
		}
		const voiceSection = voiceGuidance ? `\n\n${voiceGuidance}` : '';

		// Owner-confirmed clarification facts (trusted; rendered outside the
		// untrusted tags by the shared service).
		const confirmedContext = buildConfirmedContext(
			loaded.clarificationQuestions ? { questions: loaded.clarificationQuestions } : undefined
		);

		try {
			const result = await runSharedDraft(ctx, {
				model: getLLMProvider('draft'), // capable tier
				audience: 'the mailbox owner',
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
			});

			if (result.draftBody.trim().length === 0) return; // nothing usable

			await ctx.runMutation(internal.mail.draftOnArrivalStore.persistDraftSlot, {
				threadId: args.threadId,
				triggerMessageId: loaded.triggerMessageId,
				draft: result.draftBody,
				draftSubject: buildReplySubject(loaded.triggerSubject),
				// Surface the quality self-check score as the confidence; unknown
				// quality shows a deliberately low value so review-first reads right.
				confidence: result.draftQuality?.score ?? UNKNOWN_QUALITY_CONFIDENCE,
				...(result.draftQuality ? { quality: result.draftQuality } : {}),
				...(result.draftOptions.length > 0 ? { options: result.draftOptions } : {}),
			});
		} catch (err) {
			// Injection re-scan / LLM error → no slot; the thread still shows for
			// manual reply. Never wedge the caller.
			logError('[draftOnArrival] generation failed:', err);
		}
	},
});
