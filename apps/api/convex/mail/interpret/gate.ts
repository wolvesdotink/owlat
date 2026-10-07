/**
 * The spend gate of an interpretation run (SPEC §4 step 4), checked before the
 * model is called. Interpretation runs in the background, with no user behind
 * it, so it does not take the per-user rate limit of `mail/ai/gate.ts`; it
 * takes the two switches that matter:
 *
 *   - the `ai` feature flag;
 *   - the spend ceiling (`analytics/spendBudget.ts`, the ledger every call
 *     records into). Brief mode is advisory AI and stops at the advisory
 *     reserve, like the Postbox AI. Actions mode feeds the Team Inbox pipeline
 *     and runs until the ceiling itself; past it, the brief is incomplete and
 *     auto-send holds anyway (D3).
 *
 * A refusal is not an error: the run records a `failed` extraction
 * (`ai_off` / `budget`), the brief shows it as incomplete, never as "nothing
 * to do". Any error computing the budget is read as allowed (the Postbox
 * gate's fail-soft).
 */

import { v } from 'convex/values';
import { internalQuery } from '../../_generated/server';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { computeBudgetStatus } from '../../analytics/spendBudget';
import { interpretModeValidator } from '../../lib/validators/threadBrief';

export const checkAllowed = internalQuery({
	args: { mode: interpretModeValidator },
	returns: v.union(
		v.object({ isAllowed: v.literal(true) }),
		v.object({
			isAllowed: v.literal(false),
			code: v.union(v.literal('ai_off'), v.literal('budget')),
		})
	),
	handler: async (ctx, args) => {
		if (!(await isFeatureEnabled(ctx, 'ai')))
			return { isAllowed: false as const, code: 'ai_off' as const };
		try {
			const budget = await computeBudgetStatus(ctx);
			const isWithin =
				args.mode === 'brief' ? budget.advisoryAllowed : budget.autonomousAutoSendAllowed;
			if (!isWithin) return { isAllowed: false as const, code: 'budget' as const };
		} catch {
			// A budget that cannot be computed does not stop interpretation.
		}
		return { isAllowed: true as const };
	},
});
