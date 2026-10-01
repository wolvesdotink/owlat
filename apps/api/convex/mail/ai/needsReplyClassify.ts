'use node';

/**
 * Reply Queue classification action (see mail/needsReply.ts for the module
 * overview). Runs per-thread, scheduled by inbound ingest or the reconcile
 * cron:
 *
 *   1. Deterministic screen over the newest thread messages
 *      (mail/needsReplyHeuristic.ts). Not a candidate → clears the flag and
 *      finishes (no LLM spend).
 *   2. Candidate → persists the deterministic flag FIRST (source `heuristic`,
 *      urgency `normal`), so a crash or LLM failure anywhere after this point
 *      still leaves the baseline signal (fail-soft).
 *   3. LLM refinement on the cheap "summarize" tier, behind the same aiGate
 *      as the user-triggered Postbox AI (feature flag + rate limit). The
 *      thread body is attacker-controlled inbound mail, so it is framed as
 *      untrusted DATA (SYSTEM_GUARD), mirroring mail/ai/assist.ts. The model
 *      NAMES the message from the closed reply-intent taxonomy (./replyIntent.ts)
 *      and that module — not the model's boolean — decides whether the row
 *      belongs in the queue, so an FYI or a recap full of action items can no
 *      longer promote itself. The result only ever updates the advisory flag —
 *      it never sends or modifies mail.
 */

import { v, type Infer } from 'convex/values';
import { z } from 'zod';
import { internalAction } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject, runLlmText } from '../../lib/llm/dispatch';
import { recordLlmSpend } from '../../analytics/llmUsage';
import {
	evaluateNeedsReplyCandidate,
	isPublishingAddress,
	isUnattendedAddress,
} from '../needsReplyHeuristic';
import {
	REPLY_INTENTS,
	buildReplyIntentPrompt,
	decideNeedsReply,
	normalizeDueHint,
	normalizeMeetingIntent,
} from './replyIntent';
import {
	replySlotsSchema,
	divergenceSchema,
	buildSlotPrompt,
	buildCandidatePrompt,
	buildDivergencePrompt,
	sanitizeClarificationQuestions,
	DIVERGENCE_SAMPLES,
	MIN_SAMPLES_FOR_JUDGMENT,
	type ReplySlot,
} from '../../inbox/clarificationSlots';
import { SYSTEM_GUARD } from './promptGuards';
import { applyMemoryFills, withAnswerKind } from '../../inbox/clarificationAnswers';
import { draftClarificationReply } from './needsReplyDraft';
import { logError } from '../../lib/runtimeLog';
import type { needsReplyClarificationValidator } from '../../lib/validators/clarification';
import { localizeQuestions } from '../../inbox/clarificationLocalize';

const refinementSchema = z.object({
	// What the message IS (closed taxonomy, ai/replyIntent.ts). The queue
	// verdict is decided from this, not from `needsReply` alone.
	intent: z.enum(REPLY_INTENTS),
	needsReply: z.boolean(),
	urgency: z.enum(['high', 'normal', 'low']),
	// One line: what the sender is asking of the reader. Empty when nothing is.
	askSummary: z.string().nullable(),
	// ISO 8601 date (YYYY-MM-DD) when the message states a deadline.
	dueHint: z.string().nullable(),
	// Plain-prose scheduling request ("can we meet…"). Null when the message is
	// not proposing/asking to schedule a meeting.
	meetingIntent: z
		.object({
			isScheduling: z.boolean(),
			// Verbatim time phrases the sender used ("Tuesday afternoon").
			proposedTimes: z.array(z.string()),
			topic: z.string().nullable(),
		})
		.nullable(),
});

export const classifyThread = internalAction({
	args: {
		threadId: v.id('mailThreads'),
		// Ingest-time headers of the triggering message — only available on the
		// ingest trigger (none of them are persisted on the row, so the reconcile
		// sweep re-classifies without them and leans on the sender screens).
		precedence: v.optional(v.string()),
		/** RFC 3834 Auto-Submitted. */
		autoSubmitted: v.optional(v.string()),
		/** RFC 2919 List-Id. */
		listId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const context = await ctx.runQuery(internal.mail.needsReply.getThreadContext, {
			threadId: args.threadId,
		});
		if (!context) return;

		const evaluation = evaluateNeedsReplyCandidate({
			ownerAddresses: context.ownerAddresses,
			messages: context.messages,
			precedence: args.precedence,
			autoSubmitted: args.autoSubmitted,
			listId: args.listId,
		});

		if (!evaluation.candidate) {
			await ctx.runMutation(internal.mail.needsReply.applyResult, {
				threadId: args.threadId,
				expectedLatestMessageId: context.latestMessageId,
				needsReply: null,
			});
			return;
		}

		const latestInbound = context.messages[evaluation.latestInboundIndex];
		if (!latestInbound) return;

		// Persist the deterministic candidate first — the LLM pass below is a
		// refinement, and any failure in it must leave this baseline in place.
		await ctx.runMutation(internal.mail.needsReply.applyResult, {
			threadId: args.threadId,
			expectedLatestMessageId: context.latestMessageId,
			needsReply: {
				messageId: latestInbound.messageId,
				source: 'heuristic',
				urgency: 'normal',
			},
		});

		try {
			// Same gate as the user-triggered Postbox AI: `ai` feature flag +
			// rate limit. Throws when disabled/limited → deterministic flag stays.
			await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});

			const transcript = context.transcript; // side-labelled, built in getThreadContext

			const { object, tokenUsage, modelUsed } = await runLlmObject({
				// High-volume background classification → cheap "summarize" tier.
				model: await resolveLanguageModel(ctx, 'summarize'),
				schema: refinementSchema,
				prompt: buildReplyIntentPrompt({
					systemGuard: SYSTEM_GUARD,
					ownerAddress: context.ownerAddress,
					transcript,
					senderLooksAutomated: isPublishingAddress(latestInbound.fromAddress),
				}),
				temperature: 0,
			});
			await recordLlmSpend(ctx, 'postbox_needs_reply', tokenUsage, modelUsed);

			// The queue verdict: the model's intent AND its boolean AND a sender who
			// can receive the reply (ai/replyIntent.ts). An FYI/recap/receipt is
			// dropped here even when the model's boolean said otherwise.
			const decision = decideNeedsReply({
				intent: object.intent,
				modelNeedsReply: object.needsReply,
				isUnattendedSender: isUnattendedAddress(latestInbound.fromAddress),
			});

			// Clarification loop: only when the message genuinely needs a reply do
			// we spend the extra passes deciding whether a good reply is missing a
			// fact only the owner can supply. Self-contained fail-soft (returns
			// undefined on any error) so a clarification failure never downgrades
			// the refinement above.
			let clarification = decision.needsReply
				? await refineClarification(ctx, {
						transcript,
						fromAddress: latestInbound.fromAddress,
					})
				: undefined;

			// ANSWER-MEMORY: pre-pick any question a stored standing answer (scoped
			// to this sender's contact, or org-general) already resolves. The
			// question stays on the card with `answer.source = 'memory'`, shown as
			// "last time", so a remembered answer is never used silently; the owner
			// confirms or changes it. Fail-soft: any lookup error leaves the
			// questions unanswered (ask exactly as today).
			if (clarification && clarification.questions.length > 0) {
				try {
					const { fills } = await ctx.runMutation(internal.inbox.clarificationMemory.resolveFills, {
						fromAddress: latestInbound.fromAddress,
						questions: clarification.questions.map((q) => ({
							id: q.id,
							slotType: q.slotType,
							text: q.text,
						})),
					});
					clarification = {
						...clarification,
						questions: applyMemoryFills(clarification.questions, fills, Date.now()),
					};
				} catch {
					// Leave the clarification untouched — ask as today.
				}
			}

			// Narrow catch, distinct from the outer one: the outer catch also absorbs
			// the expected aiGate refusal (AI off, rate-limited) and stays silent. A
			// throw here is a real fault (e.g. the result no longer matching the
			// applyResult validator), so log it and keep the heuristic flag. Only
			// the first line: a Convex validation error goes on to print the whole
			// argument, and that carries the ask summary and question text.
			try {
				await ctx.runMutation(internal.mail.needsReply.applyResult, {
					threadId: args.threadId,
					expectedLatestMessageId: context.latestMessageId,
					needsReply: decision.needsReply
						? {
								messageId: latestInbound.messageId,
								source: 'llm',
								urgency: object.urgency,
								askSummary: object.askSummary?.trim().slice(0, 120) || undefined,
								dueHint: normalizeDueHint(object.dueHint),
								meetingIntent: normalizeMeetingIntent(object.meetingIntent, {
									hasCalendarInvite: latestInbound.hasCalendarInvite,
								}),
								clarification,
							}
						: null,
				});
			} catch (err) {
				logError(
					'[needsReplyClassify] applyResult failed:',
					err instanceof Error ? err.message.split('\n', 1)[0] : 'non-Error thrown'
				);
			}
		} catch {
			// Fail-soft (AI disabled, rate-limited, provider down, bad output):
			// the deterministic candidate flag persisted above stands.
		}
	},
});

type SpendCtx = Parameters<typeof recordLlmSpend>[0];

/**
 * The clarification refineClarification produces: the persisted
 * `needsReply.clarification` shape (lib/validators/clarification.ts) before
 * the owner answers, so without `answeredAt` and `draft`.
 */
type ClarificationFlag = Omit<
	Infer<typeof needsReplyClarificationValidator>,
	'answeredAt' | 'draft'
>;

/**
 * Decide whether a good reply to this thread is missing a fact only the owner
 * can supply, and if so return the sanitized clarification questions.
 *
 * REUSES the shared slot taxonomy + prompt module (inbox/clarificationSlots.ts)
 * that the inbound agent `clarify` step uses — no fork. Two stages:
 *   1. cheap-tier slot extraction (the 'summarize' tier) → candidate
 *      slots that are BOTH unanswerable from context AND decision-relevant.
 *   2. capable-tier divergence confirmation (the 'draft' tier), run ONLY
 *      when stage 1 flagged a candidate: sample a few independent replies and
 *      keep only the slots they genuinely disagree on. A converging slot is a
 *      safe assumption and is dropped.
 * Every survivor is deterministically sanitized (credential/OTP solicitations
 * dropped, attributed to the sender). FAIL-SOFT: any error returns undefined so
 * the needs-reply refinement is never downgraded by a clarification failure.
 */
export async function refineClarification(
	ctx: SpendCtx,
	opts: { transcript: string; fromAddress: string }
): Promise<ClarificationFlag | undefined> {
	try {
		// Stage 1 — cheap-tier reply-slot extraction (shared prompt module).
		const slotsResult = await runLlmObject({
			model: await resolveLanguageModel(ctx, 'summarize'),
			schema: replySlotsSchema,
			prompt: buildSlotPrompt(opts.transcript),
			temperature: 0.2,
		});
		await recordLlmSpend(
			ctx,
			'postbox_clarify_slots',
			slotsResult.tokenUsage,
			slotsResult.modelUsed
		);

		const candidateSlots: ReplySlot[] = [];
		for (const slot of slotsResult.object.slots) {
			if (!slot.answerableFromContext && slot.decisionRelevant) candidateSlots.push(slot);
		}
		if (candidateSlots.length === 0) return undefined;

		// Stage 2 — capable-tier divergence confirmation (only reached because a
		// candidate was flagged). Sample independent replies; a slot they diverge
		// on is a genuine open question.
		const drafts: string[] = [];
		for (let i = 0; i < DIVERGENCE_SAMPLES; i++) {
			try {
				const draft = await runLlmText({
					model: await resolveLanguageModel(ctx, 'draft'),
					prompt: buildCandidatePrompt(opts.transcript),
					temperature: 0.9,
				});
				if (draft.text.trim().length > 0) {
					drafts.push(draft.text);
					await recordLlmSpend(ctx, 'postbox_clarify_diverge', draft.tokenUsage, draft.modelUsed);
				}
			} catch {
				// One failed sample doesn't abort the check — judge on the rest.
			}
		}
		// Can't judge divergence with too few samples → don't invent questions.
		if (drafts.length < MIN_SAMPLES_FOR_JUDGMENT) return undefined;

		const divergenceResult = await runLlmObject({
			model: await resolveLanguageModel(ctx, 'draft'),
			schema: divergenceSchema,
			prompt: buildDivergencePrompt(candidateSlots, drafts),
			temperature: 0.1,
		});
		await recordLlmSpend(
			ctx,
			'postbox_clarify_diverge',
			divergenceResult.tokenUsage,
			divergenceResult.modelUsed
		);

		const divergent = new Set(divergenceResult.object.divergentSlotIndexes);
		const raw = [];
		for (let i = 0; i < candidateSlots.length; i++) {
			if (!divergent.has(i)) continue;
			const slot = candidateSlots[i]!;
			raw.push({ slotType: slot.slotType, text: slot.question, options: slot.options });
		}
		if (raw.length === 0) return undefined;

		// Deterministic safety filter: drop credential/OTP solicitations, attribute
		// each survivor to the sender ("Owlat will never ask for your password").
		// Each survivor gets the input its slot kind calls for (answerKind).
		const sanitized = sanitizeClarificationQuestions(raw, opts.fromAddress).map(withAnswerKind);
		if (sanitized.length === 0) return undefined;

		// Ask the owner in their own language: translate the surviving questions
		// into every other interface locale. Fail-soft to the English copy.
		const localized = await localizeQuestions(
			await resolveLanguageModel(ctx, 'summarize'),
			sanitized
		);
		if (localized.tokenUsage) {
			await recordLlmSpend(
				ctx,
				'postbox_clarify_localize',
				localized.tokenUsage,
				localized.modelUsed
			);
		}

		return { isNeeded: true, questions: localized.questions, askedAt: Date.now() };
	} catch {
		return undefined;
	}
}

/**
 * Produce the starter reply for an answered clarification card, so it flips
 * from "Needs your input" to "Draft ready".
 *
 * Scheduled by `mail.needsReplyClarify.answerClarification`. Drafts through the
 * shared draft service with the knowledge recall tool, the same way the team
 * pipeline drafts after its clarification (see ./needsReplyDraft.ts). FAIL-SOFT:
 * any gate/model failure leaves the card with the answers recorded and no
 * starter draft — the plain "Draft reply" button still works.
 */
export const draftWithAnswers = internalAction({
	args: { threadId: v.id('mailThreads') },
	handler: (ctx, args) => draftClarificationReply(ctx, args),
});
