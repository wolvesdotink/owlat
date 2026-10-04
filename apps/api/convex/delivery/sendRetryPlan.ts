import { admitGovernedRetry, type GovernedDeadlineVerdict } from '@owlat/shared';
import { clampRetryAfterMs, LOCAL_DEFER_MS, RETRY_AFTER_MIN_MS } from '../lib/sendProviders/errors';
import type { SendWorkerOutcome } from './workerOutcome';

/**
 * How the send completion answers the deadline arm of the governed retry budget.
 *
 * A DIVERGENCE FROM THE OTHER CALL SITES, PRESERVED DELIBERATELY. Dispatch and
 * routing re-entry refuse a `startedAt` that lies in the future; the completion
 * has always admitted one, because its comparison is a bare `now - startedAt <
 * MAX_AGE` and a negative age satisfies it. The two readings only differ under a
 * clock that moved backwards, and turning this into a refusal would terminalize
 * a send that still has its whole delivery window left — the opposite of what
 * every arm there is for. An unreadable age (`NaN`, an infinitely old start) is
 * still refused, exactly as the bare comparison refused it.
 */
export function deadlineAdmits(verdict: GovernedDeadlineVerdict): boolean {
	return verdict === 'ok' || verdict === 'clock_reversed';
}

type RetryableOutcome = Extract<SendWorkerOutcome, { kind: 'deferred' | 'acceptanceUnknown' }>;

/**
 * Whether a deferral or an open acceptance is re-entered, and after how long;
 * null when the budget has run out and the completion terminalizes instead.
 * One decision for the completion's two arms and for the completion-failure
 * record (#1195), which re-enters the Send itself when the arm threw.
 *
 *   - `acceptanceUnknown` is replayed under the SAME idempotency key, so it is
 *     not routing churn and the attempt cap has never bounded it: only the
 *     cumulative deadline does.
 *   - `deferred` is bounded by BOTH. The retry state carried here is the
 *     successor's (the dispatch boundary already incremented it, and declined
 *     to for a policy hold), so admitting `attempt <= MAX` is the exact
 *     complement of the cap dispatch would refuse this same number on.
 */
export function governedRetryDelayMs(outcome: RetryableOutcome, now: number): number | null {
	const budget = admitGovernedRetry(outcome.retryState, now);
	if (outcome.kind === 'acceptanceUnknown') {
		return deadlineAdmits(budget.deadline)
			? clampRetryAfterMs(outcome.retryAfterMs, RETRY_AFTER_MIN_MS)
			: null;
	}
	return budget.attempts === 'ok' && deadlineAdmits(budget.deadline)
		? clampRetryAfterMs(outcome.retryAfterMs, LOCAL_DEFER_MS)
		: null;
}
