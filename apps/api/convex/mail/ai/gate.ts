/**
 * Gate for the user-triggered Postbox AI actions. Lives outside the 'use node'
 * mail/ai/assist.ts (which can't hold mutations) so the action can runMutation it
 * before spending an LLM call: it enforces the `ai` feature flag and a
 * per-user rate limit, mirroring the inbound pipeline's gating.
 */
import { v } from 'convex/values';
import type { FunctionReturnType } from 'convex/server';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { internalMutation, type ActionCtx } from '../../_generated/server';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { rateLimiter } from '../../lib/rateLimiter';
import { throwForbidden, throwRateLimited } from '../../_utils/errors';
import { computeBudgetStatus } from '../../analytics/spendBudget';

/**
 * Per-user rate-limit bucket the gate charges. Each user-triggered AI surface
 * passes its OWN bucket so one feature's tight loop can't starve another's
 * headroom; `postboxAiPerUser` stays the default for the original callers.
 */
const AI_RATE_BUCKET = v.union(
	v.literal('postboxAiPerUser'),
	v.literal('translateBatchPerUser'),
	v.literal('quickQueryPerUser')
);

export const assertAiAllowed = internalMutation({
	args: { rateLimitBucket: v.optional(AI_RATE_BUCKET) },
	handler: async (ctx, args) => {
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
		const res = await rateLimiter.limit(ctx, args.rateLimitBucket ?? 'postboxAiPerUser', { key });
		if (!res.ok) {
			throwRateLimited('AI is busy — try again in a moment.', res.retryAfter);
		}
	},
});

type ThreadMessages = FunctionReturnType<typeof api.mail.mailbox.messages.listThreadMessages>;

/**
 * Run the gate while `work` (setup the AI call needs anyway: the thread read,
 * the model resolution, the voice profile) is already in flight, instead of one
 * round trip after the other. The gate still decides: its verdict is awaited
 * first, so a disabled flag, spent budget or rate limit throws its own error
 * even when `work` failed too, and nothing `work` produced leaves the action
 * unless the gate passed. `work` is always settled before this returns or
 * throws, so no read is left dangling when the action ends.
 */
export async function gatedInParallel<T>(ctx: ActionCtx, work: Promise<T>): Promise<T> {
	const settled = Promise.resolve(work).then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error })
	);
	try {
		await ctx.runMutation(internal.mail.ai.gate.assertAiAllowed, {});
	} catch (gateError) {
		await settled;
		throw gateError;
	}
	const outcome = await settled;
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

/**
 * The message's thread through the same ownership-checked query the AI actions
 * always used (null for a message the caller cannot read).
 */
export function readThreadMessages(
	ctx: ActionCtx,
	messageId: Id<'mailMessages'>
): Promise<ThreadMessages> {
	return ctx.runQuery(api.mail.mailbox.messages.listThreadMessages, { messageId });
}

/** {@link gatedInParallel} over {@link readThreadMessages}. */
export function gateAndLoadThread(
	ctx: ActionCtx,
	messageId: Id<'mailMessages'>
): Promise<ThreadMessages> {
	return gatedInParallel(ctx, readThreadMessages(ctx, messageId));
}
