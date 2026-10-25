'use node';

/**
 * Answer mode's coverage check, in place of the catch-up card's
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

import { awaitFullRead } from './fullReadPrepare';
import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import { resolveLanguageModel } from '../../lib/llmProvider';
import { runLlmObject } from '../../lib/llm/dispatch';
import { interactiveLlmPolicy } from '../../lib/llm/retryPolicy';
import { meterLlmCall } from '../../analytics/meteredSpend';
import { newRootRequest } from '../../lib/llm/requestMeter';
import { draftRefValidator } from '../../lib/validators/responsePlan';
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
import { anchorActionDeadline } from '../../lib/llm/actionDeadline';
import { admissionRefusalOf } from '../../lib/llm/admissionPort';
import type { BudgetHoldReason } from '@owlat/shared/aiRouting';

/** The longest draft the check reads. */
const MAX_DRAFT_CHARS = 20_000;

/** What the composer gets back. */
export interface CoverageResult extends PlanCoverage<Id<'threadItems'>> {
	/** What the result is bound to: the stance revision and the text. */
	planRevision: number;
	draftHash: string;
	/** The thread and item revisions it read: an item change invalidates it (review r2 F3). */
	threadRevision: number;
	itemRevisions: { itemId: Id<'threadItems'>; revision: number }[];
	/** The model answered. Without it only the attachment claims are known. */
	isChecked: boolean;
	/** Set when spend admission refused the check (`AI_BUDGET_EXHAUSTED`); the web says why. */
	budgetRefusal?: BudgetHoldReason;
	/** Stored as the draft's coverage; false when newer stances superseded it. */
	isStored: boolean;
}

/**
 * The model's plan check, or null when the gate refused or the call failed.
 * A spend-admission refusal is reported instead of read as a fault.
 */
async function checkWithModel(
	ctx: ActionCtx,
	items: readonly PlanPromptItem[],
	draft: string,
	onBudgetRefusal: (reason: BudgetHoldReason) => void
): Promise<PlanCheckOutput | null> {
	// File claims and commitments are checked even when no item is planned or
	// every item is skipped (review F12).
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {
			rateLimitBucket: 'answerCoveragePerUser',
		});
		const model = await resolveLanguageModel(ctx, 'mail.plan_coverage');
		const { object } = await meterLlmCall(
			ctx,
			{ feature: 'answer_plan_coverage', root: newRootRequest('postbox_action') },
			(meter) =>
				runLlmObject({
					meter,
					model,
					schema: planCheckSchema,
					prompt: buildPlanCoveragePrompt({ items, draft }),
					temperature: 0,
					...interactiveLlmPolicy('reply'),
				}),
			{ write: 'schedule' }
		);
		return object;
	} catch (error) {
		const refusal = admissionRefusalOf(error);
		if (refusal) onBudgetRefusal(refusal.reason);
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
	},
	handler: async (ctx, args): Promise<CoverageResult | null> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		const read = () =>
			ctx.runQuery(internal.mail.interpret.responsePlanDraft.loadForCoverage, {
				threadRef: args.threadRef,
				draftRef: args.draftRef,
			});
		let loaded = await read();
		if (!loaded) return null;
		// Read on arrival: gist-only mail of the thread is read in full first,
		// waited for a little; still preparing, nothing is checked (Sol r2 F1).
		// After the access check above.
		if (!loaded.isFullyRead) {
			if ((await awaitFullRead(ctx, args.threadRef)) === 'preparing') return null;
			loaded = await read();
			if (!loaded) return null;
		}
		const draft = args.draftText.slice(0, MAX_DRAFT_CHARS);
		const items = toPromptItems(loaded.items, loaded.stances);
		let budgetRefusal: BudgetHoldReason | undefined;
		const output = draft.trim()
			? await checkWithModel(ctx, items, draft, (reason) => {
					budgetRefusal = reason;
				})
			: null;
		const checked = parsePlanCheck(output, {
			draft,
			items,
			attachments: loaded.attachments,
		});
		const draftHash = await draftHashOf(draft);
		const isCheckIncomplete = checked.isIncomplete || loaded.isOverflow;
		const stored = await ctx.runMutation(internal.mail.interpret.responsePlanDraft.recordCheck, {
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
			planRevision: loaded.planRevision,
			deletionEpoch: loaded.deletionEpoch,
			attachmentSetHash: loaded.attachmentSetHash,
			isCheckIncomplete,
		});
		return {
			...checked,
			isIncomplete: isCheckIncomplete,
			planRevision: loaded.planRevision,
			draftHash,
			threadRevision: loaded.threadRevision,
			itemRevisions: loaded.items.map((i) => ({ itemId: i.id, revision: i.revision })),
			isChecked: output !== null,
			// The model was not asked because the AI budget said no.
			...(budgetRefusal ? { budgetRefusal } : {}),
			isStored: stored.isStored,
		};
	},
});
