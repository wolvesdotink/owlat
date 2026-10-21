/**
 * Gate for every Postbox AI call made through `mail.ai.*`. Lives outside the
 * 'use node' mail/ai/assist.ts (which can't hold mutations) so an action can
 * runMutation it before spending an LLM call: it enforces the `ai` feature
 * flag, spend admission and a rate limit.
 *
 * Rate-limit keying (#1380). A call with a session is charged to the session
 * user in an interactive per-user bucket. Scheduled work has no session
 * (Convex passes no auth to scheduled functions), so a background caller MUST
 * pass `ownerUserId`, the user whose bucket pays (the mailbox owner, or the
 * person whose click scheduled the work), and is charged to the
 * `postboxAiBackground` bucket under that key. A session-less call without it
 * throws: there is no shared fallback key any more.
 */
import { ConvexError, v } from 'convex/values';
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
 * Per-user rate-limit bucket an interactive call is charged to. Each
 * user-triggered AI surface passes its OWN bucket so one feature's tight loop
 * can't starve another's headroom; `postboxAiPerUser` stays the default for
 * the original callers. Session-less calls ignore it (`postboxAiBackground`).
 */
const AI_RATE_BUCKET = v.union(
	v.literal('postboxAiPerUser'),
	v.literal('translateBatchPerUser'),
	v.literal('quickQueryPerUser'),
	v.literal('answerCoveragePerUser')
);

/** Thrown for a session-less gate call that names no owner: a caller bug, never a refusal. */
export const MISSING_AI_OWNER_MESSAGE =
	'assertAiAllowed: a call without a session must pass ownerUserId';

export const assertAiAllowed = internalMutation({
	args: {
		rateLimitBucket: v.optional(AI_RATE_BUCKET),
		/** Required without a session: the user whose background bucket pays. */
		ownerUserId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// Resolved first: a caller that names nobody is a bug whatever the flag says.
		const session = await getBetterAuthSessionWithRole(ctx);
		const charge = session
			? { bucket: args.rateLimitBucket ?? 'postboxAiPerUser', key: session.userId }
			: args.ownerUserId
				? { bucket: 'postboxAiBackground' as const, key: args.ownerUserId }
				: null;
		if (!charge) throw new Error(MISSING_AI_OWNER_MESSAGE);

		if (!(await isFeatureEnabled(ctx, 'ai'))) {
			throwForbidden('AI features are disabled');
		}

		// Spend admission: a user-triggered feature needs headroom
		// outside the triage allowance and the reserve held for the Team
		// pipeline, read from the complete period aggregate. FAIL-CLOSED (#1333):
		// a spend state that cannot be verified refuses. The refusal carries the
		// stable `AI_BUDGET_EXHAUSTED` code the web shows (U5). Each model call
		// the action then makes is admitted again at dispatch, with a hold.
		const budget = await budgetHeadroom(ctx, { priority: 'interactive' });
		if (!budget.isAdmitted) throwBudgetRefused(budget);

		const res = await rateLimiter.limit(ctx, charge.bucket, { key: charge.key });
		if (!res.ok) {
			throwRateLimited('AI is busy — try again in a moment.', res.retryAfter);
		}
	},
});

/**
 * The rate-limit refusal an error carries (the gate's `rate_limited`
 * operation error, also after it crossed the action boundary), with the
 * limiter's `retryAfter` in ms when it named one; null for anything else,
 * including a budget refusal.
 */
export function rateLimitRefusalOf(error: unknown): { retryAfter?: number } | null {
	if (!(error instanceof ConvexError)) return null;
	const payload = error.data as { category?: unknown; data?: { retryAfter?: unknown } } | null;
	if (!payload || typeof payload !== 'object' || payload.category !== 'rate_limited') return null;
	const retryAfter = payload.data?.retryAfter;
	return typeof retryAfter === 'number' ? { retryAfter } : {};
}

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
