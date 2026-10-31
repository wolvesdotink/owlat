/**
 * The AI spend budget as people read it. Spend admission refuses
 * a paid call with a stable code (`AI_BUDGET_EXHAUSTED`, the reason beside it),
 * a refused draft stream finishes with that code as its `errorMessage`, and a
 * Team message the ceiling held carries `budgetHold`. This module turns each
 * into catalog keys; it never shows the server's English sentence.
 */
import {
	AI_BUDGET_ERROR_CODE,
	BUDGET_HOLD_REASONS,
	type BudgetHoldReason,
	type MissingJudgment,
} from '@owlat/shared/aiRouting';
import type { OperationError } from '@owlat/shared/operationError';

const K = 'shared.aiBudget';

/** One sentence per reason; total over the shared union. */
export const BUDGET_REASON_KEYS: Record<BudgetHoldReason, string> = {
	daily_ceiling: `${K}.reason.dailyCeiling`,
	monthly_ceiling: `${K}.reason.monthlyCeiling`,
	spend_unverifiable: `${K}.reason.spendUnverifiable`,
};

/** A held message's skipped judgments, as words; total over the shared union. */
export const MISSING_JUDGMENT_KEYS: Record<MissingJudgment, string> = {
	guard: `${K}.judgment.guard`,
	classify: `${K}.judgment.classify`,
	interpret: `${K}.judgment.interpret`,
	clarify: `${K}.judgment.clarify`,
	draft: `${K}.judgment.draft`,
};

/** The sentence for a refusal whose reason is not known (a refused draft stream). */
export const BUDGET_GENERIC_KEY = `${K}.generic`;

const REASONS: ReadonlySet<string> = new Set(BUDGET_HOLD_REASONS);

/** The reason of a refusal payload (`{ code, reason }`), or null for anything else. */
export function budgetRefusalReason(data: unknown): BudgetHoldReason | null {
	const payload = data as { code?: unknown; reason?: unknown } | null | undefined;
	if (payload?.code !== AI_BUDGET_ERROR_CODE) return null;
	return typeof payload.reason === 'string' && REASONS.has(payload.reason)
		? (payload.reason as BudgetHoldReason)
		: null;
}

/** A normalized operation failure that is the budget refusal, and its reason. */
export function budgetReasonOf(op: OperationError): BudgetHoldReason | null {
	return budgetRefusalReason(op.data);
}

/**
 * A raw thrown error (a `ConvexError` caught outside the operation layer,
 * whose payload is `error.data.data`) that is the budget refusal.
 */
export function budgetReasonOfError(error: unknown): BudgetHoldReason | null {
	return budgetRefusalReason((error as { data?: { data?: unknown } } | null)?.data?.data);
}

/**
 * The catalog key for a thrown error that is the budget refusal (the reason's
 * sentence), or null for any other failure. For the client call sites that
 * call a paid action directly and catch it themselves.
 */
export function budgetCopyKeyOfError(error: unknown): string | null {
	const reason = budgetReasonOfError(error);
	return reason ? BUDGET_REASON_KEYS[reason] : null;
}

/** A draft stream (compose, revise) that ended on the budget. */
export function isBudgetStreamError(errorMessage: string | null | undefined): boolean {
	return errorMessage === AI_BUDGET_ERROR_CODE;
}

/** `inboundMessages.budgetHold`: why a Team message waits for a person. */
export interface BudgetHold {
	reason: BudgetHoldReason;
	missingJudgments: MissingJudgment[];
	at: number;
}
