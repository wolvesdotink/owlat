/**
 * The spend gate of an interpretation run, checked before the
 * model is called. Interpretation runs in the background, with no user behind
 * it, so it does not take the per-user rate limit of `mail/ai/gate.ts`; it
 * takes the two switches that matter:
 *
 *   - the `ai` feature flag;
 *   - spend admission, read from the complete period
 *     aggregate (`aiRouting/enforcedBudget.ts`). Brief mode is background
 *     work: it stops at the advisory reserve and defers. Actions mode feeds
 *     the Team Inbox pipeline and runs until the ceiling itself; past it, the
 *     brief is incomplete and auto-send holds anyway. A spend state that
 *     cannot be verified refuses (#1333).
 *
 * A refusal is not an error: the run records a `failed` extraction
 * (`ai_off` / `budget`), the brief shows it as incomplete, never as "nothing
 * to do".
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../../_generated/server';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { budgetHeadroom } from '../../aiRouting/enforcedBudget';
import { interpretModeValidator } from '../../lib/validators/threadBrief';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { BUDGET_HOLD_REASONS, type BudgetHoldReason } from '@owlat/shared/aiRouting';
import { literalUnion } from '../../lib/literalUnion';

export type InterpretGateVerdict =
	| { isAllowed: true }
	| { isAllowed: false; code: 'ai_off' }
	/** With the refusal's reason and limit, for a caller that holds on it (Sol r3 F5). */
	| { isAllowed: false; code: 'budget'; reason: BudgetHoldReason; limit: string };

/**
 * The gate itself, for a query or a mutation: the run checks it before the
 * model call (`checkAllowed`), and the backfill and the lazy first-open
 * interpretation check it before they schedule anything (`backfill.ts`,
 * `lazy.ts`), so a spent budget never queues work it would refuse.
 */
export async function interpretGate(
	ctx: QueryCtx,
	mode: InterpretMode
): Promise<InterpretGateVerdict> {
	if (!(await isFeatureEnabled(ctx, 'ai'))) return { isAllowed: false, code: 'ai_off' };
	const budget = await budgetHeadroom(ctx, {
		priority: mode === 'brief' ? 'background' : 'pipeline',
	});
	if (!budget.isAdmitted) {
		return { isAllowed: false, code: 'budget', reason: budget.reason, limit: budget.limit };
	}
	return { isAllowed: true };
}

export const checkAllowed = internalQuery({
	args: { mode: interpretModeValidator },
	returns: v.union(
		v.object({ isAllowed: v.literal(true) }),
		v.object({ isAllowed: v.literal(false), code: v.literal('ai_off') }),
		v.object({
			isAllowed: v.literal(false),
			code: v.literal('budget'),
			reason: literalUnion(BUDGET_HOLD_REASONS),
			limit: v.string(),
		})
	),
	handler: (ctx, args): Promise<InterpretGateVerdict> => interpretGate(ctx, args.mode),
});
