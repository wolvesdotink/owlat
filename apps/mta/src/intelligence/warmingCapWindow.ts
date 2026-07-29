/**
 * WHEN DOES A CAPPED IP GET CAPACITY BACK? (deliverability plan P3-7.)
 *
 * The warming cap is a per-UTC-DAY budget: `sentToday` resets at the UTC day
 * boundary, so an IP that has spent today's cap gets nothing back before then —
 * not in five minutes, and not in any interval short enough to be worth asking
 * again. The shipped phase deferred every cap withholding by a blind 300 s,
 * which on a capped IP means the whole deferred tail re-enters the queue every
 * five minutes for the rest of the day: a 20 000-message backlog on a capped IP
 * is ~240 pointless Redis re-queues per message per day, and every one of them
 * re-reads the same three keys to reach the same verdict.
 *
 * THE DAY BOUNDARY IS DERIVED FROM `warmingKeys.utcDateKey`, the same string the
 * cap counter resets on, rather than from a second piece of day arithmetic. The
 * deferral target and the reset key are the same fact, so they are computed from
 * the same expression and cannot disagree.
 *
 * AND THE DEFERRAL IS BOUNDED ABOVE. A daily cap is not immovable within the
 * day: the shipped adaptive evaluator can advance the schedule day, an IP can
 * join the pool, an operator can raise a cap by hand, and the ramp controller's
 * pace dial can widen one. Parking a backlog until midnight would leave it
 * sitting on capacity that became available hours earlier. So the deferral is
 * the next cap window OR `MAX_CAP_DEFER_MS`, whichever comes first — which still
 * removes ~92% of the shipped re-queues while keeping the re-ask short enough
 * that intraday capacity is never stranded for long.
 *
 * WHAT THIS IS NOT: intraday PACING already computes its own retry instant
 * (`retryAfterForPace`) because a paced attempt genuinely does get capacity back
 * within the day, on a curve. That path is untouched — only the two DAILY cap
 * gates (the per-IP cap and the per-(IP x provider) cap) defer through here.
 *
 * Pure: `now` is a parameter.
 */

import { MS_PER_UTC_DAY, utcDateKey } from './warmingKeys.js';

/**
 * Never defer by less than this. A few milliseconds before midnight the honest
 * answer is "almost immediately", and an attempt re-queued with a near-zero
 * delay is the hot loop this module exists to remove.
 */
export const MINIMUM_CAP_DEFER_MS = 60_000;

/**
 * Never defer by MORE than this. The daily cap's verdict rarely changes within
 * the day, but it genuinely can (see the module doc), and a bound is what keeps
 * a withheld backlog from sitting out capacity that already exists.
 */
export const MAX_CAP_DEFER_MS = 60 * 60 * 1000;

/**
 * Milliseconds until the next UTC day boundary — the instant the daily warming
 * cap resets, computed from the cap counter's OWN day key.
 *
 * A clock it cannot read falls back to the minimum rather than to `NaN`: a
 * deferral we cannot date must still be a deferral, and the smallest one is the
 * one that cannot strand a message.
 */
export function nextCapWindowDelayMs(now: number): number {
	if (!Number.isFinite(now)) return MINIMUM_CAP_DEFER_MS;
	const dayStart = Date.parse(`${utcDateKey(now)}T00:00:00.000Z`);
	if (!Number.isFinite(dayStart)) return MINIMUM_CAP_DEFER_MS;
	return Math.max(MINIMUM_CAP_DEFER_MS, dayStart + MS_PER_UTC_DAY - now);
}

/**
 * The deferral a spent DAILY cap earns: the next cap window, bounded above so
 * capacity that appears intraday is picked up within the hour.
 */
export function capDeferDelayMs(now: number): number {
	return Math.min(MAX_CAP_DEFER_MS, nextCapWindowDelayMs(now));
}
