/**
 * Gate for the user-triggered Postbox AI actions. Lives outside the 'use node'
 * mail/ai.ts (which can't hold mutations) so the action can runMutation it
 * before spending an LLM call: it enforces the `ai` feature flag and a
 * per-user rate limit, mirroring the inbound pipeline's gating.
 */
import { internalMutation } from '../_generated/server';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { rateLimiter } from '../rateLimiter';
import { throwForbidden, throwRateLimited } from '../_utils/errors';
import { computeBudgetStatus } from '../analytics/spendBudget';

export const assertAiAllowed = internalMutation({
	args: {},
	handler: async (ctx) => {
		if (!(await isFeatureEnabled(ctx, 'ai'))) {
			throwForbidden('AI features are disabled');
		}

		// Per-org dollar-spend budget: advisory (user-triggered) AI is paused once
		// remaining headroom drops within the reserve held for the autonomous
		// drafting path, so manual actions can't drain the budget to $0. FAIL-SOFT:
		// only a definitively-computed over-reserve state blocks; any error
		// determining the budget degrades to today's behaviour (allowed) rather
		// than breaking a user's manual action on a transient hiccup.
		let budgetBlock: string | undefined;
		try {
			const budget = await computeBudgetStatus(ctx);
			if (!budget.advisoryAllowed) {
				budgetBlock = budget.reason || 'AI spend budget reached — advisory AI is paused.';
			}
		} catch {
			// swallowed: a computation error degrades to today's (allowed) behaviour
		}
		if (budgetBlock) throwForbidden(budgetBlock);

		const session = await getBetterAuthSessionWithRole(ctx);
		const key = session?.userId ?? 'anon';
		const res = await rateLimiter.limit(ctx, 'postboxAiPerUser', { key });
		if (!res.ok) {
			throwRateLimited('AI is busy — try again in a moment.', res.retryAfter);
		}
	},
});
