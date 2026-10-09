'use node';

/**
 * Answer mode's coverage check (SPEC §6), in place of the catch-up card's
 * ask ticks: which of the reply's planned items the draft addresses, with the
 * draft's own words for each, the files it says are attached (checked against
 * the draft's real attachments) and the commitments it makes. Debounced by the
 * composer while the person writes, and run once when an AI draft lands.
 *
 * The result is stored as the draft's response plan (`draftResponsePlans`,
 * bound to the hash of the text checked) and returned. The label it drives is
 * "Addressed in draft", never "Done": nothing here changes an item.
 *
 * Gated like the catch-up coverage it replaces: the caller must read the
 * thread, and a model call passes the `ai` flag, the spend budget and its own
 * per-user rate bucket. A refusal or a model fault is no coverage, never an
 * error the page has to catch; the deterministic attachment claims still
 * come back. The draft and the item texts reach the model only as data.
 */

import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { interactiveLlmPolicy } from '../../lib/llm/retryPolicy';
import { scheduleLlmSpend } from '../../analytics/llmUsage';
import { recordSpendOnFailure } from '../../analytics/failedLlmSpend';
import { draftRefValidator, responseStanceValidator } from '../../lib/validators/threadBrief';
import { threadRefValidator } from '../../lib/validators/threadRef';
import {
	buildPlanCoveragePrompt,
	parsePlanCheck,
	planCheckSchema,
	toPromptItems,
	type PlanCheckOutput,
	type PlanPromptItem,
} from './planCheck';
import { draftHashOf, planVerdictOf, type PlanCoverage } from './responsePlanRules';

/** The longest draft the check reads. */
const MAX_DRAFT_CHARS = 20_000;

/** What the composer gets back. */
export interface CoverageResult extends PlanCoverage<Id<'threadItems'>> {
	draftHash: string;
	/** The model answered. Without it only the attachment claims are known. */
	isChecked: boolean;
}

/** The model's plan check, or null when the gate refused or the call failed. */
async function checkWithModel(
	ctx: ActionCtx,
	items: readonly PlanPromptItem[],
	draft: string
): Promise<PlanCheckOutput | null> {
	if (!items.some((i) => i.stance !== 'skip')) return null;
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
			rateLimitBucket: 'answerCoveragePerUser',
		});
		const { object, tokenUsage, modelUsed } = await recordSpendOnFailure(
			ctx,
			'answer_plan_coverage',
			runLlmObject({
				model: await resolveLanguageModel(ctx, 'summarize'),
				schema: planCheckSchema,
				prompt: buildPlanCoveragePrompt({ items, draft }),
				temperature: 0,
				...interactiveLlmPolicy('reply'),
			}),
			scheduleLlmSpend
		);
		await scheduleLlmSpend(ctx, 'answer_plan_coverage', tokenUsage, modelUsed);
		return object;
	} catch {
		return null;
	}
}

// authz: the plan is read through mail.interpret.responsePlanDraft.loadForCoverage,
// which returns null unless the caller can read the thread (mailbox access, or
// the shared-inbox reader gate) and the draft replies in it; org membership is
// enforced by authedAction; the `ai` flag, spend budget and a per-user rate
// limit by mail.ai.gate.assertAiAllowed before any model call. The draft text
// is the caller's own.
export const check = authedAction({
	args: {
		threadRef: threadRefValidator,
		draftRef: draftRefValidator,
		draftText: v.string(),
		// The owner's current stances (possibly not stored yet).
		stances: v.array(v.object({ itemId: v.id('threadItems'), stance: responseStanceValidator })),
	},
	handler: async (ctx, args): Promise<CoverageResult | null> => {
		const loaded = await ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForCoverage, {
			threadRef: args.threadRef,
			draftRef: args.draftRef,
			stances: args.stances,
		});
		if (!loaded) return null;
		const draft = args.draftText.slice(0, MAX_DRAFT_CHARS);
		const items = toPromptItems(loaded.items, loaded.stances);
		const output = draft.trim() ? await checkWithModel(ctx, items, draft) : null;
		const checked = parsePlanCheck(output, {
			draft,
			items,
			attachments: loaded.attachments,
		});
		const draftHash = await draftHashOf(draft);
		await ctx.runMutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
			threadRef: args.threadRef,
			draftRef: args.draftRef,
			threadRevision: loaded.threadRevision,
			itemRevisions: loaded.items.map((i) => ({ itemId: i.id, revision: i.revision })),
			stances: loaded.stances,
			coverage: checked.coverage,
			fileClaims: checked.fileClaims,
			newPromises: checked.newPromises,
			draftHash,
			verdict: output ? planVerdictOf(loaded.stances, checked) : 'pending',
		});
		return { ...checked, draftHash, isChecked: output !== null };
	},
});
