/**
 * WHEN DOES A CAPPED IP GET CAPACITY BACK? (deliverability plan P3-7.)
 *
 * The warming cap is a per-UTC-DAY budget: `sentToday` resets at the UTC day
 * boundary, so an IP that has spent today's cap gets nothing back until then —
 * not in five minutes, and not in any interval short enough to be worth asking
 * again. The shipped phase deferred every cap withholding by a blind 300 s,
 * which on a capped IP means the whole deferred tail re-enters the queue every
 * five minutes for the rest of the day: a 20 000-message backlog on a capped IP
 * is ~240 pointless Redis re-queues per message per day, and every one of them
 * re-reads the same three keys to reach the same verdict.
 *
 * Deferring to the NEXT CAP WINDOW instead answers the question once. The
 * verdict does not change in the meantime, so nothing is lost by not asking.
 *
 * WHAT THIS IS NOT: intraday PACING already computes its own retry instant
 * (`retryAfterForPace`) because a paced attempt genuinely does get capacity back
 * within the day, on a curve. That path is untouched — only the two DAILY cap
 * gates (the per-IP cap and the per-(IP x provider) cap) defer to the window.
 *
 * Pure: `now` is a parameter.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Never defer by less than this. At a few milliseconds before midnight the
 * honest answer is "almost immediately", and an attempt re-queued with a
 * near-zero delay is the hot loop this module exists to remove.
 */
export const MINIMUM_CAP_DEFER_MS = 60_000;

/**
 * Milliseconds until the next UTC day boundary — the instant the daily warming
 * cap resets and a capped IP is worth asking again.
 *
 * A non-finite clock falls back to the minimum rather than to `NaN`: a deferral
 * we cannot date must still be a deferral, and the smallest one is the one that
 * cannot strand a message.
 */
export function nextCapWindowDelayMs(now: number): number {
	if (!Number.isFinite(now)) return MINIMUM_CAP_DEFER_MS;
	const sinceMidnight = ((now % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
	return Math.max(MINIMUM_CAP_DEFER_MS, MS_PER_DAY - sinceMidnight);
}
