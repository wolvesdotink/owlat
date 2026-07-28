/**
 * READING WHAT THE ROW STORED — the ramp controller's sanitisers.
 *
 * Every value the decision function reads off a `deliverabilityRouteStates` row
 * arrives VERBATIM: `-0.5`, `NaN`, an instant ten days in the future and a
 * clean streak of `Number.MAX_SAFE_INTEGER` are all things a corrupt write, a
 * clock skew or a hostile input can put there. These readers are the one place
 * that decides what such a value MEANS, and every one of them fails in the
 * direction that cannot raise a share.
 *
 * They live beside `controller.ts` rather than inside it so the precedence
 * ladder — the thing a reviewer must verify in one sitting — stays the whole
 * content of that file. Same directory, so `__tests__/gates.purity.test.ts`
 * (which ENUMERATES `delivery/ramp/*.ts`) covers them the moment they land.
 *
 * PURE, like everything else under `ramp/`: no clock, no database, no
 * environment. `now` is a parameter.
 */

import { clampOwnShare } from '@owlat/shared/deliverabilityRouting';
import type { RampGateThresholds } from './gateConfig';

/**
 * Shares are stored to four decimals. Repeated additive increase on binary
 * floats drifts (0.02 + 0.05 x 19 lands on 0.9699999999999999), and a drifting
 * share makes every fixture approximate and every audit row unreadable.
 */
const SHARE_PRECISION = 10_000;

export function roundShare(value: number): number {
	return Math.round(clampOwnShare(value) * SHARE_PRECISION) / SHARE_PRECISION;
}

export function sanitizeStreak(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
	return Math.floor(value);
}

/**
 * ONE reading of a stored instant, for every rung that has to decide whether a
 * timestamp on the row can be believed: `null` means the value is NOT USABLE as
 * a past instant — absent, non-finite, non-positive, or ahead of the clock.
 *
 * Spelling this out once matters more than it looks: three rungs used to
 * hand-roll the same three conditions with slightly different wording, and the
 * one that forgot the future check was how a graduation clock could be handed
 * out early.
 */
export function readStoredInstant(stored: number | undefined, now: number): number | null {
	if (stored === undefined || !Number.isFinite(stored) || stored <= 0) return null;
	if (stored > now) return null;
	return stored;
}

/**
 * The one distinction `readStoredInstant` deliberately collapses: an anchor
 * AHEAD of the clock. Unreadable and future are both unusable, but the window
 * gate must treat them differently — see `isEvaluationWindowElapsed`.
 */
export function isStoredInstantAhead(stored: number | undefined, now: number): boolean {
	return stored !== undefined && Number.isFinite(stored) && stored > now;
}

/**
 * The graduation clock, sanitised. A stored instant that is missing, corrupt,
 * non-positive or AHEAD OF THE CLOCK restarts the count at `now`: the only
 * failure mode we accept here is graduating a cell LATER than it deserved.
 */
export function sanitizeGreenSince(stored: number | undefined, now: number): number {
	return readStoredInstant(stored, now) ?? now;
}

/**
 * IS THIS AGGREGATE STILL EVIDENCE?
 *
 * The gate aggregate carries the instant it was computed against, and the
 * controller may only spend evidence that is actually about the present. An
 * aggregate is usable when its `evaluatedAt` is a finite instant, no older than
 * `maxEvidenceAgeMs`, and no further ahead of the clock than `maxFutureSkewMs`.
 *
 * Both allowances come from the SHIPPED model rather than being chosen here:
 * the skew tolerance is the routing-snapshot validator's own
 * (`DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS`), so a gap that validator
 * rejects cannot be accepted as fresh evidence one layer up.
 *
 * WHY THIS EXISTS AT ALL. The cron builds the aggregate in-process against the
 * same `now` it passes the controller, so today every aggregate is fresh by
 * construction. That is a property of ONE caller, not of the function: a
 * substitution table, a replay tool or a what-if screen all hand the decision
 * function an aggregate they did not just compute, and without this an
 * aggregate produced last month, replayed once per elapsed window, would buy a
 * step per window for ever. The decision function's promise is that no input
 * can raise a share on thin data; evidence with no expiry is thin data.
 */
export function isEvidenceUsable(
	evaluatedAt: number,
	now: number,
	thresholds: RampGateThresholds
): boolean {
	if (!Number.isFinite(evaluatedAt)) return false;
	if (evaluatedAt > now + thresholds.maxFutureSkewMs) return false;
	return now - evaluatedAt <= thresholds.maxEvidenceAgeMs;
}
