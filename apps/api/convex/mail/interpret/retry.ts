/**
 * When an incomplete extraction is tried again (review F2). Pure.
 *
 *   - Transient failures (a verifier or model call that failed, a revision
 *     that kept moving, a body that changed under the run) are retried with
 *     backoff, at most {@link MAX_RETRIES} times; the run that comes next
 *     repairs the extraction and the reducer replays the thread.
 *   - A gate refusal (`ai_off`, `budget`) costs nothing to re-check, so it is
 *     due on every call and never runs out.
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
	'body_unavailable',
]);
const GATE_CODES: ReadonlySet<string> = new Set(['ai_off', 'budget']);

/** Backoff before attempt `retryCount + 1`. */
export function backoffMs(retryCount: number): number {
	return BASE_BACKOFF_MS * 4 ** Math.max(0, retryCount);
}

/** When the next attempt is due, or undefined when none will be made. */
export function nextRetryAtOf(
	row: { status: string; errorCode?: string; retryCount?: number },
	now: number
): number | undefined {
	if (row.status !== 'partial' && row.status !== 'failed') return undefined;
	const code = row.errorCode ?? '';
	if (GATE_CODES.has(code)) return now;
	const count = row.retryCount ?? 0;
	if (!BACKOFF_CODES.has(code) || count >= MAX_RETRIES) return undefined;
	return now + backoffMs(count);
}

/** Whether a stored incomplete extraction should be run again now. */
export function isRetryDue(row: { nextRetryAt?: number }, now: number): boolean {
	return row.nextRetryAt !== undefined && now >= row.nextRetryAt;
}
