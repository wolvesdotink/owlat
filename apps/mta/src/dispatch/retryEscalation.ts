/**
 * How long a message waits before its next attempt after a receiver deferred it
 * or every MX host failed.
 *
 * The classifier's delay for the reply (greylisting, a provider's rate-limit
 * signature, the volume-pressure lengthening) is a floor that the ladder never
 * shortens. On top of it the wait grows with the receiver deferrals this
 * message has already collected, because a receiver that keeps refusing is
 * best left alone: retrying every 30-60 s for four days reads to a mailbox
 * provider as abusive and prolongs a temporary block, and RFC 5321 §4.5.4.1
 * asks for at least 30 minutes between attempts after the first few.
 *
 * The first deferral costs only the floor, so a greylisted or briefly
 * refused transactional message comes back as fast as it always did. The
 * ladder then starts at a minute and doubles to an hour, which it holds until
 * the max message age ends the message. That lifetime takes about a hundred
 * rungs, far inside the per-message successor budget (`queue/deferBudget.ts`).
 */

import { nextDelay, type RetryPolicy } from '@owlat/shared/retryPolicy';

const RECEIVER_DEFERRAL_LADDER = {
	baseMs: 60_000,
	factor: 2,
	capMs: 3_600_000,
} as const satisfies RetryPolicy;

/**
 * The retry delay for a message whose earlier attempts the receiver deferred
 * `priorDeferrals` times (zero on its first deferral).
 */
export function escalatedRetryDelayMs(floorMs: number, priorDeferrals: number): number {
	const prior = Number.isSafeInteger(priorDeferrals) && priorDeferrals > 0 ? priorDeferrals : 0;
	if (prior === 0) return floorMs;
	return nextDelay(RECEIVER_DEFERRAL_LADDER, prior - 1, floorMs);
}
