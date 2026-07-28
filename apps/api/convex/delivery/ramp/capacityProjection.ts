/**
 * THE PREDICTIVE HALF OF CAPACITY HANDLING (plan P3-3).
 *
 * The REACTIVE half already ships: when a send would exceed the warming cap the
 * route resolver hands that recipient to the relay with
 * `deliverabilityReason: 'warmup_overflow'` (`lib/sendProviders/warmingCapGate.ts`).
 * That works, but it works one recipient at a time and only after the fact. This
 * module is the other half — project how much volume a cell is about to make, so
 * the controller never promises the own MTA more than its warming cap can carry
 * and most overflow is never assigned to it in the first place.
 *
 * WHAT IS PROJECTED, AND WHY IT IS A TRAILING STATISTIC RATHER THAN A MEAN.
 * A cell's demand is not smooth: a campaign send is a spike, a paused campaign
 * is a week of zeros, and a newsletter that doubles its list is a real trend.
 * The projection therefore takes the LARGER of two medians — the trailing week's
 * and the last three days' — so that
 *
 *   · a steady week projects itself,
 *   · a growing week tracks the growth (the recent median leads the weekly one),
 *   · a single spike is NOT a trend (a median of three ignores one outlier),
 *   · and a paused week projects nothing at all rather than zero.
 *
 * DEGENERATE DATA IS THE INTERESTING CASE, and there is exactly one right
 * answer for it: HOLD. An unknown projection must not become an infinite ceiling
 * (the controller would ramp hardest where it understands least) and must not
 * become a zero one (a cell with no measured demand is not a cell in trouble).
 * `projectCellVolume` answers `unknown` for every one of them — no history, a
 * paused week, an unusable clock — and `capacityCeiling` maps that onto a hold.
 * Above all, a projected volume of ZERO never reaches a division: it is the
 * `no_volume` unknown, decided here, once.
 *
 * PURE (plan D15): `now` is a parameter. Nothing here reads a clock, a database
 * or the environment; `startOfDayUtc` is dependency-free day arithmetic over its
 * argument (`lib/clock.ts`).
 */

import { startOfDayUtc } from '../../lib/clock';
import { MS_PER_DAY } from '../../lib/constants';

/** How many COMPLETE UTC days the projection looks back over. */
export const CAPACITY_TRAILING_DAYS = 7;

/** How many of the most recent days the "is it growing?" median runs over. */
const CAPACITY_RECENT_DAYS = 3;

/**
 * Below this much of the UTC day remaining, today's capacity reading is not
 * usable: both the remaining cap and the remaining demand are collapsing toward
 * zero, and their ratio turns to noise that would retreat healthy cells every
 * evening. The last ~70 minutes of a day hold rather than decide.
 */
export const CAPACITY_MIN_DAY_FRACTION_REMAINING = 0.05;

/**
 * ONE COMPLETE UTC DAY of a cell's traffic, both arms.
 *
 * `total` is the cell's DEMAND — everything it sent that day, whichever
 * transport carried it — and `own` is the part the own MTA actually carried.
 * The gap between them is what makes a `warmup_overflow` reroute visible: the
 * resolver moves a recipient to the relay, so the day's `own` falls while its
 * `total` does not.
 */
export interface CellVolumeDay {
	readonly dayStartMs: number;
	readonly total: number;
	readonly own: number;
}

/**
 * Why a projection could not be made. Every one of these HOLDS (plan D10): the
 * controller neither increases nor decreases on data it does not have.
 */
export type CellVolumeUnknownReason =
	/** No complete trailing day carried any row at all — a brand-new cell. */
	| 'no_history'
	/** Complete days exist but project no volume — a paused or empty cell. */
	| 'no_volume'
	/** `now` is not a usable instant, so the trailing window cannot be placed. */
	| 'clock_unusable';

export type CellVolumeProjection =
	| { readonly kind: 'unknown'; readonly reason: CellVolumeUnknownReason }
	| {
			readonly kind: 'projected';
			/** Projected DEMAND for a whole day, both arms. Always > 0. */
			readonly dailyVolume: number;
			/** Projected volume the OWN arm carries, at the trailing mix. */
			readonly ownDailyVolume: number;
			/** How many complete trailing days carried data. */
			readonly observedDays: number;
			/** `ownDailyVolume / dailyVolume`, clamped to [0, 1]. */
			readonly ownFraction: number;
	  };

/** A counter that is missing, negative, NaN or infinite contributes 0. */
function safeVolume(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Median of a non-empty list. Even lengths take the lower-upper mean. */
function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid] ?? 0;
	if (sorted.length % 2 === 1) return upper;
	return ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/**
 * The trailing statistic: the larger of the whole window's median and the
 * recent window's median.
 *
 * MAX, not a blend. Under-projecting demand is the unsafe direction — it raises
 * the ceiling and lets the controller assign the own MTA volume its warming cap
 * cannot carry — so a cell that is visibly growing is projected at its growth
 * rather than at the week's typical day, while a cell whose recent days are a
 * single outlier keeps the week's median (a median of three cannot be moved by
 * one spike).
 */
function trailingStatistic(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const recent = values.slice(-CAPACITY_RECENT_DAYS);
	return Math.max(median(values), median(recent));
}

/**
 * Project one cell's daily volume from its trailing COMPLETE days.
 *
 * TODAY IS DELIBERATELY EXCLUDED. A partial day is a partial count, and letting
 * it into the statistic would drag every projection toward zero in the morning
 * and back up by evening — the projection would say the least exactly when the
 * day's sending was still ahead of it.
 *
 * Days are aggregated by `dayStartMs` before anything is measured, so a caller
 * that hands over one entry per shard (or per arm) gets the same answer as one
 * that pre-summed them.
 */
export function projectCellVolume(
	days: readonly CellVolumeDay[],
	now: number
): CellVolumeProjection {
	if (!Number.isFinite(now)) return { kind: 'unknown', reason: 'clock_unusable' };
	const today = startOfDayUtc(now);
	const windowStart = today - CAPACITY_TRAILING_DAYS * MS_PER_DAY;

	const byDay = new Map<number, { total: number; own: number }>();
	for (const day of days) {
		if (!Number.isFinite(day.dayStartMs)) continue;
		const dayStart = startOfDayUtc(day.dayStartMs);
		if (dayStart < windowStart || dayStart >= today) continue;
		const bucket = byDay.get(dayStart) ?? { total: 0, own: 0 };
		bucket.total += safeVolume(day.total);
		// The own arm is a PART of the day's demand, never more than it: a caller
		// that double-counted would otherwise project an own fraction above 1 and
		// make the cell look like it carried more than it sent.
		bucket.own += safeVolume(day.own);
		byDay.set(dayStart, bucket);
	}
	if (byDay.size === 0) return { kind: 'unknown', reason: 'no_history' };

	const ordered = [...byDay.entries()].sort(([a], [b]) => a - b);
	const totals = ordered.map(([, value]) => value.total);
	const owns = ordered.map(([, value]) => Math.min(value.own, value.total));

	const dailyVolume = trailingStatistic(totals);
	// A ZERO PROJECTION NEVER LEAVES THIS FUNCTION. It is the numerator of every
	// ceiling downstream, and `x / 0` is the defect this branch exists to make
	// impossible — a paused week is "we do not know what it will send", not "it
	// will send nothing, so give it everything".
	if (!(dailyVolume > 0)) return { kind: 'unknown', reason: 'no_volume' };

	const ownDailyVolume = Math.min(trailingStatistic(owns), dailyVolume);
	return {
		kind: 'projected',
		dailyVolume,
		ownDailyVolume,
		observedDays: byDay.size,
		ownFraction: Math.min(1, Math.max(0, ownDailyVolume / dailyVolume)),
	};
}

/**
 * HOW MUCH OF THE PROJECTED DAY IS STILL AHEAD, and `null` when the answer is
 * not usable.
 *
 * The warming cap is a DAILY allowance and the MTA reports what is LEFT of it
 * today, so the demand it is compared against has to be what is left of today
 * too. Comparing a decaying remainder against a whole day's demand is the
 * documented sawtooth: the ceiling would collapse through every afternoon and
 * retreat cells whose gates are all green.
 *
 * The remaining day is assumed to carry demand at a UNIFORM rate. That is not
 * true of campaign traffic — a burst that already happened leaves less demand
 * ahead than this says — and the error runs in the SAFE direction: over-stating
 * the demand ahead lowers the ceiling.
 */
export function remainingDemandToday(dailyVolume: number, now: number): number | null {
	if (!Number.isFinite(dailyVolume) || dailyVolume <= 0) return null;
	if (!Number.isFinite(now)) return null;
	const elapsed = now - startOfDayUtc(now);
	const remainingFraction = 1 - elapsed / MS_PER_DAY;
	if (!(remainingFraction >= CAPACITY_MIN_DAY_FRACTION_REMAINING)) return null;
	if (remainingFraction > 1) return null;
	return dailyVolume * remainingFraction;
}

/**
 * WHAT SHARE OF THE OWN ARM'S ASSIGNED TRAFFIC NEVER REACHED IT — the reactive
 * half, seen from the controller's side.
 *
 * A `warmup_overflow` reroute writes its outcome under the arm that actually
 * carried the send (`sendAssignments.armForTransport`), so a rerouted recipient
 * lands in the `reference` arm: the cell's trailing `own` volume falls while its
 * `total` does not, and this ratio is how far the delivered mix fell short of
 * the assigned share. It is EVIDENCE, not a decision — it is carried into the
 * `mixDecisions` audit snapshot (plan D12) so an operator can see that the own
 * arm did not carry what it was promised, and no rung reads it.
 *
 * `null` whenever the question is meaningless: an unusable projection, or a cell
 * assigned no own traffic at all (there is nothing to have missed).
 */
export function rerouteMissRate(
	projection: CellVolumeProjection,
	assignedShare: number
): number | null {
	if (projection.kind !== 'projected') return null;
	if (!Number.isFinite(assignedShare) || assignedShare <= 0) return null;
	const shortfall = assignedShare - projection.ownFraction;
	if (shortfall <= 0) return 0;
	return Math.min(1, shortfall / assignedShare);
}
