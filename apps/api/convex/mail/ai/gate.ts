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
import type { ActionCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { rateLimiter } from '../../lib/rateLimiter';
import { throwForbidden, throwRateLimited } from '../../_utils/errors';
import { budgetHeadroom, throwBudgetRefused } from '../../aiRouting/enforcedBudget';

/**
 * Per-user rate-limit bucket the gate charges. Each user-triggered AI surface
 * passes its OWN bucket so one feature's tight loop can't starve another's
 * headroom; `postboxAiPerUser` stays the default for the original callers.
 */
const AI_RATE_BUCKET = v.union(
	v.literal('postboxAiPerUser'),
	v.literal('translateBatchPerUser'),
	v.literal('quickQueryPerUser'),
	v.literal('answerCoveragePerUser')
);

export const assertAiAllowed = internalMutation({
	args: { rateLimitBucket: v.optional(AI_RATE_BUCKET) },
	handler: async (ctx, args) => {
		if (!(await isFeatureEnabled(ctx, 'ai'))) {
			throwForbidden('AI features are disabled');
		}

		// Spend admission (ADR-0073, D1): a user-triggered feature needs headroom
		// outside the triage allowance and the reserve held for the Team
		// pipeline, read from the complete period aggregate. FAIL-CLOSED (#1333):
		// a spend state that cannot be verified refuses. The refusal carries the
		// stable `AI_BUDGET_EXHAUSTED` code the web shows (U5). Each model call
		// the action then makes is admitted again at dispatch, with a hold.
		const budget = await budgetHeadroom(ctx, { priority: 'interactive' });
		if (!budget.isAdmitted) throwBudgetRefused(budget);

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
