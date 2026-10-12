/**
 * When an incomplete extraction is tried again (review F2). Pure.
 *
 *   - Transient failures (a verifier or model call that failed, a revision
 *     that kept moving, a body that changed under the run) are retried with
 *     backoff, at most {@link MAX_RETRIES} times; the run that comes next
 *     repairs the extraction and the reducer replays the thread.
 *   - A gate refusal (`ai_off`, `budget`) costs nothing to re-check, so it is
 *     due on every call and never runs out.
 *   - A run whose one spend hold was refused (`budget` with
 *     `budgetDeferrals`, Sol r4) spent nothing, but the hold is the run's whole
 *     paid path: it backs off from 5 minutes, doubling to 6 hours, for at most
 *     {@link MAX_BUDGET_DEFERRALS} deferrals.
 *   - Deterministic outcomes (overflow, grounding, the replay budget,
 *     eligibility) are not retried.
 */

export const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5 * 60 * 1000;

const BACKOFF_CODES: ReadonlySet<string> = new Set([
	'verify',
	'model_error',
	'stale',
	'source_changed',
	'mode_changed',
	'body_unavailable',
]);
const GATE_CODES: ReadonlySet<string> = new Set(['ai_off', 'budget']);

/** Hold refusals of one revision before it waits for a new trigger. */
export const MAX_BUDGET_DEFERRALS = 24;
const BUDGET_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

/** Backoff before the run that follows deferral `deferrals` (1-based). */
export function budgetBackoffMs(deferrals: number): number {
	return Math.min(BUDGET_BACKOFF_MAX_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, deferrals - 1));
}

/** Backoff before attempt `retryCount + 1`. */
export function backoffMs(retryCount: number): number {
	return BASE_BACKOFF_MS * 4 ** Math.max(0, retryCount);
}

/** When the next attempt is due, or undefined when none will be made. */
export function nextRetryAtOf(
	row: { status: string; errorCode?: string; retryCount?: number; budgetDeferrals?: number },
	now: number
): number | undefined {
	if (row.status !== 'partial' && row.status !== 'failed') return undefined;
	const code = row.errorCode ?? '';
	if (code === 'budget' && row.budgetDeferrals !== undefined) {
		if (row.budgetDeferrals > MAX_BUDGET_DEFERRALS) return undefined;
		return now + budgetBackoffMs(row.budgetDeferrals);
	}
	if (GATE_CODES.has(code)) return now;
	// `retryCount` counts admitted attempts (model calls), the first included:
	// the first read plus at most MAX_RETRIES repairs.
	const attempts = row.retryCount ?? 1;
	if (!BACKOFF_CODES.has(code) || attempts > MAX_RETRIES) return undefined;
	return now + backoffMs(attempts - 1);
}

/** Whether a stored incomplete extraction should be run again now. */
export function isRetryDue(row: { nextRetryAt?: number }, now: number): boolean {
	return row.nextRetryAt !== undefined && now >= row.nextRetryAt;
}
