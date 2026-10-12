'use node';

/**
 * The divergence stage of Postbox clarification, split out of
 * `./needsReplyClassify.ts` to hold it under the size cap. Node runtime: it
 * runs the shared LLM dispatch.
 */

import type { ActionCtx } from '../../_generated/server';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject, runLlmText } from '../../lib/llm/dispatch';
import { meterLlmCall, type LlmSpendTarget } from '../../analytics/meteredSpend';
import { rethrowAdmissionRefusal } from '../../lib/llm/admissionPort';
import {
	buildCandidatePrompt,
	buildDivergencePrompt,
	divergenceSchema,
	DIVERGENCE_SAMPLES,
	MIN_SAMPLES_FOR_JUDGMENT,
	type ReplySlot,
} from '../../inbox/clarificationSlots';

/**
 * Stage 2 of `./needsReplyClassify.ts` `refineClarification`: sample independent replies on the
 * capable tier and keep the candidate slots they genuinely disagree on. Empty
 * when there is nothing to judge, too few samples came back to judge at all
 * (don't invent questions), or the judgment failed.
 */
export async function divergentSlots(
	ctx: ActionCtx,
	transcript: string,
	candidates: readonly ReplySlot[],
	target: LlmSpendTarget
): Promise<ReplySlot[]> {
	if (candidates.length === 0) return [];
	try {
		const drafts: string[] = [];
		for (let i = 0; i < DIVERGENCE_SAMPLES; i++) {
			try {
				const model = await resolveLanguageModel(ctx, 'draft');
				const draft = await meterLlmCall(ctx, target, (meter) =>
					runLlmText({
						meter,
						model,
						prompt: buildCandidatePrompt(transcript),
						temperature: 0.9,
					})
				);
				if (draft.text.trim().length > 0) drafts.push(draft.text);
			} catch (error) {
				rethrowAdmissionRefusal(error); // a failed sample is skipped, a refusal is not
			}
		}
		if (drafts.length < MIN_SAMPLES_FOR_JUDGMENT) return [];

		const judgeModel = await resolveLanguageModel(ctx, 'draft');
		const divergenceResult = await meterLlmCall(ctx, target, (meter) =>
			runLlmObject({
				meter,
				model: judgeModel,
				schema: divergenceSchema,
				prompt: buildDivergencePrompt([...candidates], drafts),
				temperature: 0.1,
			})
		);
		const divergent = new Set(divergenceResult.object.divergentSlotIndexes);
		return candidates.filter((_, index) => divergent.has(index));
	} catch (error) {
		rethrowAdmissionRefusal(error);
		return [];
	}
}
