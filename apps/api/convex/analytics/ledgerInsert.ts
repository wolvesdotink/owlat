/**
 * The one ledger insert (ADR-0073): every `llmUsageEvents` row is written by
 * {@link insertLlmUsage}, which prices the row, stamps the routing columns,
 * and adds the row to the spend-period aggregate in the same mutation. Split
 * out of `./llmUsage.ts` (which re-exports it) to hold that file under the
 * size cap.
 *
 * Each row also carries `spendGeneration`: the aggregate generation it was
 * counted under (`llmSpendAggregateState.generation`, read in this mutation).
 * A rebuild (`aiRouting/spendAggregate.ts`) counts exactly the rows whose
 * generation is older than its own, so a row is counted once whether it was
 * written before the rebuild started or while it ran, with no clock in the
 * argument: the rebuild's start mutation and every insert read the same state
 * row, so they serialize.
 */

import type { MutationCtx } from '../_generated/server';
import type { TokenUsage } from '../agent/steps/types';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import { estimateCost, PRICE_VERSION } from '../lib/llm/pricing';
import type { LlmUsagePlane } from '../lib/llmUsageTags';
import type { BudgetClass, QualityResult } from '../lib/validators/aiRouting';
import { taskForFeature, taskPolicy } from '../lib/llm/taskPolicy';
import { usdToMicrousd } from '../lib/aiRouting/spendPeriods';
import {
	addLedgerRowToSpendPeriods,
	currentSpendGeneration,
} from '../lib/aiRouting/spendPeriodWrites';

/**
 * Per-row annotations beyond feature and cost, mirroring the table's optional
 * tag columns (`lib/llmUsageTags.ts`). `plane` applies to every plane; the
 * three flags below it are the DECISION plane's and are absent elsewhere. All
 * optional, so a caller that knows none of them writes exactly today's row
 * (plus the price version, and the task its feature maps to).
 */
export interface LlmUsageTags {
	readonly plane?: LlmUsagePlane;
	/** The dispatch's id for one logical call, repeated across its retries and its hop. */
	readonly requestId?: string;
	/** The attempt ran on the language-backed fallback hop, not the native plane. */
	readonly isFallback?: boolean;
	/** The answering adapter's probabilities are calibrated across groups. */
	readonly isCalibrated?: boolean;
	/** Upstream pushed back: 429, or 529 (their overload code). */
	readonly isThrottled?: boolean;
	/** Ran on the operator's own hardware: priced at zero and labelled `Local`. */
	readonly isLocalEngine?: boolean;
	// AI routing columns (ADR-0073); meanings in `lib/llmUsageTags.ts`.
	readonly rootRequestId?: string;
	readonly parentCallId?: string;
	/** Defaults to the task the feature maps to (`taskForFeature`). */
	readonly task?: AiTaskName;
	readonly policyVersion?: number;
	readonly attempt?: number;
	readonly endpoint?: string;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly reasoningTokens?: number;
	readonly latencyMs?: number;
	readonly qualityResult?: QualityResult;
	/** No usage was reported: the cost is an estimate (zero when nothing is known). */
	readonly isEstimated?: boolean;
	/** Defaults to the task's budget class; a shadow call passes `shadow`. */
	readonly budgetClass?: BudgetClass;
	readonly reservationId?: string;
	/**
	 * Admission settlement only (`aiRouting/settlement.ts`): the row's cost is
	 * this conservative estimate in integer micro-USD, not a price of usage, or
	 * a negative adjustment that offsets part of an earlier estimate. The row
	 * is marked `isEstimated`.
	 */
	readonly settledEstimateMicrousd?: number;
}

/** No reported usage: an unknown spend, or a request refused before billing. */
export const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

interface LlmUsageAttribution {
	readonly organizationId: string;
	readonly pluginId: string;
}

/** The budget class a row counts under: the caller's, else its task's, else standard. */
function rowBudgetClass(tags: LlmUsageTags | undefined, task: AiTaskName | undefined): BudgetClass {
	if (tags?.budgetClass) return tags.budgetClass;
	return task ? taskPolicy(task).budgetClass : 'standard';
}

/** The row's cost: a settlement's given estimate, else the price of its usage. */
function rowCost(
	tags: LlmUsageTags | undefined,
	modelUsed: string | undefined,
	tokenUsage: TokenUsage,
	pricedPlane: LlmUsagePlane
): { costUsd: number; costMicrousd: number; isEstimated: boolean | undefined } {
	const given = tags?.settledEstimateMicrousd;
	// Negative only for an adjustment that offsets an earlier estimate.
	if (given !== undefined && Number.isSafeInteger(given)) {
		return { costUsd: given / 1_000_000, costMicrousd: given, isEstimated: true };
	}
	// A local engine bills nothing, whatever its model id would price at. A
	// model the price table does not know is priced at its plane's conservative
	// fallback, and the row says the cost is an estimate.
	const isLocal = tags?.isLocalEngine === true;
	const priced = isLocal ? undefined : estimateCost(modelUsed, tokenUsage, pricedPlane);
	const costUsd = priced?.costUsd ?? 0;
	const isPriceUnknown = priced?.estimated === true && tokenUsage.totalTokens > 0;
	const isEstimated = tags?.isEstimated === true || isPriceUnknown ? true : tags?.isEstimated;
	return { costUsd, costMicrousd: usdToMicrousd(costUsd), isEstimated };
}

/**
 * The one ledger insert. Shared mutation-local writer so plugin settlement and
 * its audit stay atomic. Stamps the price version, the integer cost and the
 * aggregate generation, fills the task from the feature when the caller gave
 * none, and adds the row to the spend-period aggregate in the same mutation.
 */
export async function insertLlmUsage(
	ctx: MutationCtx,
	feature: string,
	tokenUsage: TokenUsage,
	modelUsed: string | undefined,
	attribution?: LlmUsageAttribution,
	tags?: LlmUsageTags
): Promise<InsertedLedgerRow> {
	const task = tags?.task ?? taskForFeature(feature);
	// The row's plane: the caller's, else its task's (an embedding row is one
	// whoever wrote it). Absent still reads as language.
	const pricedPlane = tags?.plane ?? (task ? taskPolicy(task).plane : 'language');
	const plane = tags?.plane ?? (pricedPlane === 'language' ? undefined : pricedPlane);
	const { costUsd, costMicrousd, isEstimated } = rowCost(tags, modelUsed, tokenUsage, pricedPlane);
	const budgetClass = rowBudgetClass(tags, task);
	const createdAt = Date.now();
	const spendGeneration = await currentSpendGeneration(ctx);
	await ctx.db.insert('llmUsageEvents', {
		feature,
		organizationId: attribution?.organizationId,
		pluginId: attribution?.pluginId,
		modelUsed,
		promptTokens: tokenUsage.promptTokens,
		completionTokens: tokenUsage.completionTokens,
		totalTokens: tokenUsage.totalTokens,
		costUsd,
		createdAt,
		plane,
		requestId: tags?.requestId,
		isFallback: tags?.isFallback,
		isCalibrated: tags?.isCalibrated,
		isThrottled: tags?.isThrottled,
		isLocalEngine: tags?.isLocalEngine,
		rootRequestId: tags?.rootRequestId,
		parentCallId: tags?.parentCallId,
		task,
		policyVersion: tags?.policyVersion,
		attempt: tags?.attempt,
		endpoint: tags?.endpoint,
		cacheReadTokens: tags?.cacheReadTokens,
		cacheWriteTokens: tags?.cacheWriteTokens,
		reasoningTokens: tags?.reasoningTokens,
		latencyMs: tags?.latencyMs,
		qualityResult: tags?.qualityResult,
		priceVersion: PRICE_VERSION,
		isEstimated,
		costMicrousd,
		budgetClass,
		reservationId: tags?.reservationId,
		spendGeneration,
	});
	await addLedgerRowToSpendPeriods(
		ctx,
		{
			plane: pricedPlane,
			budgetClass,
			microusd: costMicrousd,
			isEstimated: isEstimated === true,
			at: createdAt,
		},
		spendGeneration
	);
	return {
		costMicrousd,
		isUnknownUsage: isEstimated === true && costMicrousd === 0 && tags?.isLocalEngine !== true,
	};
}

/** What one insert wrote: its integer cost, and whether its usage is unknown. */
export interface InsertedLedgerRow {
	readonly costMicrousd: number;
	/** No usage was reported and nothing was priced: a request whose cost is unknown. */
	readonly isUnknownUsage: boolean;
}
