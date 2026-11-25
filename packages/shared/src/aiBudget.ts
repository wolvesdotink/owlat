/**
 * The AI spend budget's shared vocabulary: why a Team message waits for a
 * person, and the code a refused paid call carries. A module of its own so the
 * web app's error mapping, which nearly every page loads, can read the code
 * without pulling in the routing tables of `aiRouting.ts`.
 */

/** Why a Team message waits for a person instead of the model path. */
export const BUDGET_HOLD_REASONS = [
	'daily_ceiling',
	'monthly_ceiling',
	'spend_unverifiable',
] as const;
export type BudgetHoldReason = (typeof BUDGET_HOLD_REASONS)[number];

/** The model judgments a held message is missing. */
export const MISSING_JUDGMENTS = ['guard', 'classify', 'interpret', 'clarify', 'draft'] as const;
export type MissingJudgment = (typeof MISSING_JUDGMENTS)[number];

/**
 * The stable code a spend-admission refusal carries. A refused paid
 * call throws `ConvexError({ category: 'forbidden', message, data: { code,
 * reason } })`, where `reason` is a {@link BudgetHoldReason}; the web reads
 * `error.data.data.code` to show the budget state instead of a generic error.
 */
export const AI_BUDGET_ERROR_CODE = 'AI_BUDGET_EXHAUSTED';

/**
 * The error text a Team message held by the ceiling fails with. The
 * reason and the missing judgments are on the message's `budgetHold`.
 */
export const BUDGET_HOLD_ERROR_MESSAGE =
	'AI spend budget reached: the message waits for a person (no paid model calls ran).';
