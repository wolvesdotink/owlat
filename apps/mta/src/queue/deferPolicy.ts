import type { ReservedJob } from 'groupmq';
import type { EmailJob } from '../types.js';

/** The two defer sources used by dispatch logging and telemetry. */
export type DeferKind = 'self_throttle' | 'remote_4xx';

/** Add ±15% jitter so simultaneous deferrals do not form a retry herd. */
export function withJitter(delayMs: number): number {
	const jitterFactor = 0.85 + Math.random() * 0.3;
	return Math.round(delayMs * jitterFactor);
}

/**
 * A deferral we cannot date is still a deferral, and the smallest sane one is
 * the one that can neither strand a message nor hot-loop. Same reasoning, and
 * the same number, as `warmingCapWindow.MINIMUM_CAP_DEFER_MS`.
 */
const UNREADABLE_DEFER_DELAY_MS = 60_000;

/**
 * THE ONE PLACE A DEFER DELAY IS BOUNDED BEFORE IT REACHES THE QUEUE.
 *
 * Delays reach `disposeDefer` from five unrelated places — a classifier parsing
 * remote text, a warming window, a breaker cooldown, a domain backoff read back
 * out of Redis, a fixed 60 s — and each of those is bounded, or not, on its own
 * terms. Two things are true of every one of them and of nothing else:
 *
 *   - A successor scheduled past its message's own expiry can never deliver.
 *     It wakes to an expired defer-handoff receipt (written with a
 *     `GOVERNED_MTA_MAX_MESSAGE_AGE_MS` TTL), `promoteDeferredHandoff` throws,
 *     and the message dead-letters with no terminal edge — strictly worse than
 *     the expired-bounce it would have earned by waking at the deadline. So the
 *     wake is pulled back to the deadline, where the age check terminates it
 *     properly.
 *   - A non-finite or non-positive delay is not a wait at all. `NaN` reaches
 *     GroupMQ as a `:delayed` score, and `0` is the immediate re-enqueue that
 *     is the runaway ladder, not a backoff.
 *
 * Both are cheap to state here and impossible to forget at one of the five
 * call sites. `remainingLifetimeMs` is what the message has left before its
 * max-age cap; the caller has already refused anything at or past it.
 */
export function boundedDeferDelayMs(delayMs: number, remainingLifetimeMs: number): number {
	const requested = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : UNREADABLE_DEFER_DELAY_MS;
	const remaining =
		Number.isFinite(remainingLifetimeMs) && remainingLifetimeMs > 0
			? remainingLifetimeMs
			: UNREADABLE_DEFER_DELAY_MS;
	return Math.min(requested, remaining);
}

/** Wall-clock age measured from the first enqueue, including legacy jobs. */
export function messageAgeMs(job: ReservedJob<EmailJob>, now: number): number {
	const firstEnqueuedAt = job.data.firstEnqueuedAt ?? job.timestamp;
	return now - firstEnqueuedAt;
}
