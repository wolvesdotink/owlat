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
 *   - A draft with gaps is not stored: each gap becomes a question for the
 *     owner, and the reply is written from the answers (mail/ai/gapQuestions.ts).
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
import { runSharedDraft } from '../../agent/shared/draftService';
import { arrivalPlanCheck, loadThreadPlan } from './composeDraftPlan';
import { checkDraftGaps } from './gapQuestions';
import { localizeReplyQueueQuestions } from './needsReplyRefine';
import { formatVoiceSection, loadVoiceGuidance } from './voiceGuidance';
import { rootRequest } from '../../lib/llm/requestMeter';
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import { deferRefusedRun, rethrowAdmissionRefusal } from '../../analytics/backgroundDeferral';
import { prepareThreadForConsumer } from '../interpret/fullReadPrepare';
import { FULL_READ_RECHECK_MS, MAX_FULL_READ_WAITS } from '../interpret/fullRead';

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
	args: { threadId: Id<'mailThreads'>; fullReadWaits?: number }
): Promise<void> {
	const loaded = await ctx.runQuery(internal.mail.ai.draftOnArrivalStore.loadForDraft, {
		threadId: args.threadId,
	});
	if (!loaded) return; // not a live needs-reply personal-mail thread

	// Read on arrival (Sol r2 F1): no draft of a thread not fully read. Its
	// gist-only mail is read in full first; this draft looks again then.
	if ((await prepareThreadForConsumer(ctx, { kind: 'mail', id: args.threadId })) !== 'ready') {
		const fullReadWaits = (args.fullReadWaits ?? 0) + 1;
		if (fullReadWaits <= MAX_FULL_READ_WAITS) {
			await ctx.scheduler.runAfter(
				FULL_READ_RECHECK_MS,
				internal.mail.ai.draftOnArrival.generateForThread,
				{ threadId: args.threadId, fullReadWaits }
			);
		}
		return;
	}

	// Defense-in-depth: refuse if the AI stack is off, even though the schedule
	// site already flag-gated. assertAiAllowed throws when AI is disabled; that
	// (and every other failure below) degrades to no slot. Loaded first: the
	// rate limit is charged to the mailbox owner's background bucket (#1380).
	try {
		// checkpoint: admission before the model calls; the rate-limit token it
		// consumes stays spent when the draft fails later, so reruns stay bounded.
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
			ownerUserId: loaded.ownerUserId,
		});
	} catch (error) {
		rethrowAdmissionRefusal(error);
		return;
	}

	// Personalize to the owner's learned writing voice (opt-in, fail-soft). No
	// access check: a scheduled internal action for the thread's own mailbox.
	const voiceSection = formatVoiceSection(
		await loadVoiceGuidance(ctx, { mailboxId: loaded.mailboxId, requireAccess: false })
	);

	// The thread's open items with their default stances.
	const plan = await loadThreadPlan(ctx, args.threadId);

	try {
		const result = await runSharedDraft(ctx, {
			surface: 'personal',
			resolveModel: () => resolveLanguageModel(ctx, 'mail.draft'), // lazy for custom strategies
			// Name the owner's address so the model knows which side of the
			// labelled transcript it writes for (loadForDraft marks both sides).
			audience: `the mailbox owner (${loaded.ownerAddress}), answering the last message in the thread, which the other party sent`,
			styleReference: "the owner's",
			context: loaded.context,
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
			// The primary generation is the costliest call on this path; the
			// service records it under its own label, next to the self-check's,
			// on success and on a throw.
			spendLabels: { draft: 'postbox_draft', selfCheck: 'postbox_draft_selfcheck' },
			root: rootRequest('postbox_thread', args.threadId),
			...(plan ? { responsePlan: plan.prompt } : {}),
			strategyScope: { mailboxId: loaded.mailboxId, classification: 'other' },
		});

		const draft = result.draftBody.trim();
		if (draft.length === 0) return; // nothing usable

		// A fact the draft could not fill: ask the owner instead of storing it.
		// One no question may ask for (a password): no AI draft for this reply.
		const gaps = checkDraftGaps(draft, { fromAddress: loaded.senderAddress, existing: [] });
		if (gaps.kind === 'unaskable') return;
		if (gaps.kind === 'ask') {
			await ctx.runMutation(internal.mail.ai.draftOnArrivalStore.holdForGapQuestions, {
				threadId: args.threadId,
				triggerMessageId: loaded.triggerMessageId,
				questions: await localizeReplyQueueQuestions(
					ctx,
					gaps.questions,
					rootRequest('postbox_thread', args.threadId)
				),
			});
			return;
		}
		// One commit: the slot and the plan bound to its text (review F16).
		await ctx.runMutation(internal.mail.ai.draftOnArrivalStore.persistDraftSlot, {
			threadId: args.threadId,
			triggerMessageId: loaded.triggerMessageId,
			draft,
			draftSubject: buildReplySubject(loaded.triggerSubject),
			// Surface the quality self-check score as the confidence; unknown
			// quality shows a deliberately low value so review-first reads right.
			confidence: result.draftQuality?.score ?? UNKNOWN_QUALITY_CONFIDENCE,
			...(result.draftQuality ? { quality: result.draftQuality } : {}),
			...(plan ? { plan: await arrivalPlanCheck(plan, draft, result.planCoverage) } : {}),
		});
	} catch (err) {
		rethrowAdmissionRefusal(err);
		// Injection re-scan / LLM error → no slot; the thread still shows for
		// manual reply. Never wedge the caller.
		logError('[draftOnArrival] generation failed:', err);
	}
}

export const generateForThread = internalAction({
	args: {
		threadId: v.id('mailThreads'),
		/** Runs this work deferred at the spend ceiling. */
		deferrals: v.optional(v.number()),
		/** Times it looked again for the thread to be fully read (read on arrival). */
		fullReadWaits: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<void> => {
		anchorActionDeadline(ctx);
		// At the spend ceiling the draft defers to a later run.
		await deferRefusedRun(ctx, internal.mail.ai.draftOnArrival.generateForThread, args, () =>
			generateDraftOnArrival(ctx, {
				threadId: args.threadId,
				...(args.fullReadWaits !== undefined ? { fullReadWaits: args.fullReadWaits } : {}),
			})
		);
	},
});
