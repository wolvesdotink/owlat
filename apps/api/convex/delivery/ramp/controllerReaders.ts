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
 * The FREEZE READER at the end of the file belongs to the same job: "is the
 * stored freeze still running, and whose is it" is a reading of a row whose
 * numbers may be missing, corrupt or impossibly far in the future, and it fails
 * towards the smaller share in every one of those cases. The ladder POLICY that
 * decides how long the NEXT freeze runs is `controllerConfig.nextCooldownMs` —
 * a rule, not a reading, so it lives with the constants it is made of.
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
import type { RampFreezeOrigin } from './controllerTypes';
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

/**
 * WHAT THE ROW'S FREEZE PAIR MEANS, in three states rather than a boolean.
 *
 *   - `none`       — nothing frozen, or a freeze that has expired.
 *   - `active`     — a freeze this controller could have stamped, with the rung
 *                    that stamped it when the row records one.
 *   - `unreadable` — a stored expiry no rung of this controller can produce
 *                    (further out than `maxFreezeMs`). A corrupt write or a
 *                    skewed clock, not a decision.
 *
 * THE THIRD STATE IS THE POINT. Collapsing `unreadable` into `active` lets a
 * fabricated expiry a century out suppress the circuit breaker's retreat for
 * ever; collapsing it into `none` lets the same row walk straight into the
 * additive-increase branch. Neither is acceptable, so it is its own answer and
 * each caller fails towards the smaller share in its own terms: the breaker rung
 * re-charges its retreat (an unattributable freeze is not its own), and the
 * freeze rung HOLDS without pretending it knows when the hold ends.
 */
export type RampFreezeReading =
	| { readonly kind: 'none' }
	| { readonly kind: 'unreadable' }
	| {
			readonly kind: 'active';
			readonly until: number;
			/**
			 * WHICH RUNG STAMPED IT, or `undefined` for a freeze whose origin the row
			 * does not record (a legacy row written before the field existed). Unknown
			 * is deliberately NOT treated as any particular rung: the one caller that
			 * cares uses it to decline a retreat, so an unattributable freeze must
			 * never be able to buy that suppression.
			 */
			readonly origin: RampFreezeOrigin | undefined;
	  };

/**
 * THE FREEZE PAIR, as narrowly as anything needs it.
 *
 * Deliberately NOT `RampMixState`: the cron's WRITE path has to answer the same
 * question about the row it is patching, and the round-trip through a full mix
 * state was how the write path came to re-implement `frozenUntil > now` inline
 * and disagree with the rung that reads it. Both the mix state and the raw
 * `deliverabilityRouteStates` document satisfy this shape.
 */
export interface StoredFreeze {
	readonly frozenUntil?: number | undefined;
	readonly freezeReason?: RampFreezeOrigin | undefined;
}

/**
 * IS A FREEZE STILL RUNNING, AND WHOSE IS IT?
 *
 * Read by TWO rungs, which is why the ORIGIN comes back with it: the `frozen`
 * rung only asks whether anything is in force, while the breaker rung declines
 * to re-charge its retreat only while ITS OWN freeze runs — an unrelated gate
 * cooldown must not absorb a hard stop. The cron's write path reads it too, so
 * the value it carries forward onto the row is the one the next tick's rungs
 * will believe.
 *
 * `maxFreezeMs` is the longest freeze any rung can legitimately stamp, so an
 * expiry beyond it did not come from a decision and is reported `unreadable`
 * rather than believed.
 */
export function readActiveFreeze(
	stored: StoredFreeze,
	now: number,
	maxFreezeMs: number
): RampFreezeReading {
	const until = stored.frozenUntil;
	if (until === undefined || !Number.isFinite(until)) return { kind: 'none' };
	if (until > now + maxFreezeMs) return { kind: 'unreadable' };
	if (now >= until) return { kind: 'none' };
	return { kind: 'active', until, origin: stored.freezeReason };
}

/**
 * A FREEZE IS ONLY EVER LENGTHENED.
 *
 * A hard stop that lands while a longer freeze is already running must not
 * SHORTEN it. The gate-cooldown ladder can hold a cell for up to 48h, and the
 * breaker's 6h or the blocklist's 24h replacing that expiry would hand the cell
 * back its evaluation windows a day and a half early — an infrastructure
 * incident would end up SPEEDING UP a cell that had just breached a gate,
 * exactly inverting the AIMD asymmetry the plan is built on.
 *
 * So the later of the two expiries wins, and the NEW ORIGIN is kept regardless:
 * the origin answers "which rung is this freeze accountable to", and the rung
 * that just fired is the correct answer even when it is not the one that set the
 * far end. An `unreadable` stored expiry extends nothing — it is not a decision
 * this controller made, and believing it would let a fabricated instant pin a
 * cell for ever.
 */
export function extendFreezeUntil(
	stamped: number,
	stored: StoredFreeze,
	now: number,
	maxFreezeMs: number
): number {
	const active = readActiveFreeze(stored, now, maxFreezeMs);
	return active.kind === 'active' ? Math.max(stamped, active.until) : stamped;
}
