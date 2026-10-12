'use node';

/**
 * The Postbox Reply Queue clarification (split out of `./needsReplyClassify.ts`
 * to hold it under the size cap): whether a good reply misses a fact only the
 * owner can supply, through the shared clarification service
 * (`inbox/clarifyJudge.ts`), and the sanitized, localized questions.
 */

import type { Infer } from 'convex/values';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { meterLlmCall, type LlmSpendTarget } from '../../analytics/meteredSpend';
import { newRootRequest, type LlmRootContext } from '../../lib/llm/requestMeter';
import {
	sanitizeClarificationQuestions,
	splitCandidateSlots,
	itemIdForSlot,
	type SlotItem,
	type ReplySlot,
} from '../../inbox/clarificationSlots';
import {
	extractReplySlots,
	judgeOpenSlots,
	keptSlots,
	type ClarifySurface,
} from '../../inbox/clarifyJudge';
import type { BundleSubject } from '../../decision/bundleRunner';
import { withAnswerKind } from '../../inbox/clarificationAnswers';
import type { needsReplyClarificationValidator } from '../../lib/validators/clarification';
import { localizeQuestions } from '../../inbox/clarificationLocalize';
import { rethrowAdmissionRefusal } from '../../lib/llm/admissionPort';

type SpendCtx = ActionCtx;

/**
 * The clarification refineClarification produces: the persisted
 * `needsReply.clarification` shape (lib/validators/clarification.ts) before
 * the owner answers, so without `answeredAt` and `draft`.
 */
export type ClarificationFlag = Omit<
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
 *      slots that are BOTH unanswerable from context AND decision-relevant,
 *      plus every file the reply must carry that the context lacks.
 *   2. capable-tier divergence confirmation (the 'draft' tier), run ONLY
 *      when stage 1 flagged a non-file candidate: sample a few independent
 *      replies and keep only the slots they genuinely disagree on. A
 *      converging slot is a safe assumption and is dropped. A file request
 *      skips this stage (splitCandidateSlots): the samples all "attach" it.
 *      When the routing policy enforces D5, one necessity judgment replaces
 *      the samples and the judge (inbox/clarifyJudge.ts): no capable call.
 * Every survivor is deterministically sanitized (credential/OTP solicitations
 * dropped, attributed to the sender). FAIL-SOFT: any error returns undefined so
 * the needs-reply refinement is never downgraded by a clarification failure;
 * a failed divergence stage still asks for the files.
 */
export async function refineClarification(
	ctx: SpendCtx,
	opts: {
		transcript: string;
		fromAddress: string;
		items?: readonly SlotItem<Id<'threadItems'>>[];
		/** The message the clarification is for (ADR-0073). */
		root?: LlmRootContext;
		/** The same message as the necessity judgment's subject (D5). */
		subject?: BundleSubject;
	}
): Promise<ClarificationFlag | undefined> {
	const root = opts.root;
	const spend = (feature: string): LlmSpendTarget => ({ feature, ...(root ? { root } : {}) });
	const items = opts.items ?? [];
	try {
		// Stage 1 — cheap-tier reply-slot extraction (the shared service).
		const surface = postboxClarifySurface(ctx, opts);
		const extracted = await extractReplySlots(ctx, surface, opts.transcript, items);

		const { owed, toJudge } = splitCandidateSlots(extracted.slots);
		if (owed.length === 0 && toJudge.length === 0) return undefined;

		// Files first: they are what the reply cannot go out without.
		const raw = [...owed, ...(await openSlotsToAsk(ctx, surface, opts.transcript, toJudge))].map(
			(slot) => ({
				slotType: slot.slotType,
				text: slot.question,
				options: slot.options,
				itemId: itemIdForSlot(slot, items),
			})
		);
		if (raw.length === 0) return undefined;

		// Deterministic safety filter: drop credential/OTP solicitations, attribute
		// each survivor to the sender ("Owlat will never ask for your password").
		// Each survivor gets the input its slot kind calls for (answerKind).
		const sanitized = sanitizeClarificationQuestions(raw, opts.fromAddress).map(withAnswerKind);
		if (sanitized.length === 0) return undefined;

		// Ask the owner in their own language: translate the surviving questions
		// into every other interface locale. Fail-soft to the English copy.
		const localizeModel = await resolveLanguageModel(ctx, 'summarize');
		const localized = await meterLlmCall(ctx, spend('postbox_clarify_localize'), (meter) =>
			localizeQuestions(localizeModel, sanitized, undefined, meter)
		);

		return { isNeeded: true, questions: localized.questions, askedAt: Date.now() };
	} catch (error) {
		rethrowAdmissionRefusal(error);
		return undefined;
	}
}

/**
 * Postbox's surface of the shared clarification service: slots on the cheap
 * tier; today's samples and divergence judge on the capable tier, both under
 * `postbox_clarify_diverge` (samples record as `mail.clarify_sample`).
 */
function postboxClarifySurface(
	ctx: SpendCtx,
	opts: { root?: LlmRootContext; subject?: BundleSubject }
): ClarifySurface {
	const root = opts.root ?? newRootRequest('postbox');
	return {
		features: {
			slots: 'postbox_clarify_slots',
			samples: 'postbox_clarify_diverge',
			judge: 'postbox_clarify_diverge',
		},
		roles: { slots: 'summarize', samples: 'draft', judge: 'draft' },
		meter: (feature, task, call) =>
			meterLlmCall(
				ctx,
				{ feature, ...(opts.root ? { root: opts.root } : {}), ...(task ? { task } : {}) },
				call
			),
		...(opts.subject ? { subject: opts.subject } : {}),
		root,
		// The necessity call replaces calls the pipeline held at its own priority.
		priority: 'pipeline',
		// A spend refusal is never a failed sample or judgment: the run defers (D1).
		onCallError: rethrowAdmissionRefusal,
	};
}

/**
 * Stage 2 of {@link refineClarification}: the open, relevant slots that must
 * be asked (`inbox/clarifyJudge.ts`). Empty when there is nothing to judge,
 * too few samples came back to judge at all (don't invent questions), the
 * necessity judgment gave no answer, or the judgment failed.
 */
async function openSlotsToAsk(
	ctx: SpendCtx,
	surface: ClarifySurface,
	transcript: string,
	candidates: readonly ReplySlot[]
): Promise<ReplySlot[]> {
	if (candidates.length === 0) return [];
	try {
		const { judgment } = await judgeOpenSlots(ctx, surface, transcript, candidates);
		return keptSlots(judgment, candidates);
	} catch (error) {
		rethrowAdmissionRefusal(error); // a refusal defers the run (D1); any other fault asks nothing
		return [];
	}
}
