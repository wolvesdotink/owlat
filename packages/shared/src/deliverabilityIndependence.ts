/**
 * INDEPENDENCE ARITHMETIC AND THE RAMP PRESETS — pure, and shared on purpose.
 *
 * The Independence screen quotes three numbers an operator will screenshot: the
 * share of mail their own server carries, the date they stop paying a relay, and
 * the money not spent so far this month. Every one of them is a projection off
 * the SAME daily series the server already derives (plan D5: derive on read,
 * never store), so the arithmetic lives in ONE place that the Convex query and
 * the web screen both import. A dashboard and a controller that disagree about a
 * number is the failure mode ADR-0042 was written about; a dashboard and its own
 * server disagreeing is the same bug one layer up.
 *
 * NOTHING HERE READS A CLOCK, A DATABASE OR AN ENVIRONMENT (plan D15). `now` is
 * a parameter, the series is a parameter, and every degenerate input — an empty
 * series, a single point, a flat line, a retreating line, a NaN — has a named
 * answer rather than an exception.
 *
 * D2 LIVES HERE TOO. A deployment with no reference transport has no relay to
 * become independent OF: the projection returns `already_independent` and the
 * spend figure is simply absent. Neither is an error, a warning or an incomplete
 * setup — the screen renames itself (plan D14) and carries on.
 */

import type { DeliverabilityStream } from './deliverabilityRouting';

// ============ THE DAILY SERIES ============

/**
 * One UTC day of the deployment's sending, split by arm. Counts, never rates —
 * every rate on the screen is derived by the server's one summarizer.
 */
export interface IndependenceDayPoint {
	/** UTC day start. */
	readonly day: number;
	/** Sends carried by the own MTA that day. */
	readonly own: number;
	/** Sends carried by the reference transport that day. */
	readonly reference: number;
}

/**
 * A day is only usable if both counters are finite and non-negative.
 *
 * EXPORTED SO THE CHART CANNOT DISAGREE WITH THE HEADLINE. The screen filters
 * the same series before drawing it and before summing its own caption; a local
 * copy that accepted, say, a negative counter would draw a band below the
 * baseline and quote a total the server's `independenceShare` had already
 * dropped — a page and a server disagreeing about one number, which is the
 * failure this module's header is about.
 */
export function isUsablePoint(point: IndependenceDayPoint): boolean {
	return (
		Number.isFinite(point.day) &&
		Number.isFinite(point.own) &&
		Number.isFinite(point.reference) &&
		point.own >= 0 &&
		point.reference >= 0
	);
}

/**
 * The own-arm share of ONE day, or `null` for a day nobody sent on.
 *
 * `null` rather than 0: a quiet day is not a day the own server carried nothing,
 * and feeding zeroes into the trend fit is how a fortnight's holiday reads as a
 * collapse in independence.
 */
function dayOwnShare(point: IndependenceDayPoint): number | null {
	if (!isUsablePoint(point)) return null;
	const total = point.own + point.reference;
	if (total <= 0) return null;
	return point.own / total;
}

/**
 * The headline: the share of mail the own server carried across the whole
 * window, as a single ratio in [0,1], or `null` when nothing was sent at all.
 *
 * SUMMED, NOT AVERAGED. A mean of per-day shares gives a day with eleven sends
 * the same weight as a day with eleven thousand, which is how a quiet weekend
 * moves a headline nobody sent anything to move.
 */
export function independenceShare(points: readonly IndependenceDayPoint[]): number | null {
	let own = 0;
	let total = 0;
	for (const point of points) {
		if (!isUsablePoint(point)) continue;
		own += point.own;
		total += point.reference + point.own;
	}
	if (total <= 0) return null;
	return own / total;
}

// ============ THE PROJECTED DATE YOU STOP PAYING ============

/** How many days with traffic a projection needs before it will quote a date. */
export const INDEPENDENCE_PROJECTION_MIN_DAYS = 5;

/**
 * The share at which the relay is no longer carrying mail. Deliberately not
 * 1.0: the last fraction of a percent is rounding, and a date that recedes for
 * ever because one cell rounds to 0.999 is worse than no date.
 */
const INDEPENDENCE_TARGET_SHARE = 0.99;

/** How far ahead a projection is willing to look before it declines to guess. */
const INDEPENDENCE_PROJECTION_HORIZON_DAYS = 730;

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * WHEN — IF EVER — THE RELAY STOPS CARRYING MAIL, as a closed union rather than
 * a nullable date.
 *
 * The three non-answers mean genuinely different things and each earns its own
 * calm sentence on the screen: there is not enough history yet, the line is not
 * advancing (so no honest date exists), and there is nothing to become
 * independent of. Collapsing them into `null` is how a screen ends up saying
 * "unknown" to a standalone deployment that is already, definitionally, done.
 */
export type IndependenceProjection =
	| { readonly kind: 'projected'; readonly at: number; readonly dailyGainPp: number }
	| { readonly kind: 'already_independent' }
	| { readonly kind: 'not_advancing' }
	| { readonly kind: 'beyond_horizon' }
	| { readonly kind: 'insufficient_data'; readonly usableDays: number };

/**
 * Least-squares fit of own-share against day index, over the days that actually
 * carried traffic.
 *
 * A LINE, DELIBERATELY. The ramp is AIMD — additive increase in fixed steps —
 * so a straight line is the shape the controller actually draws, and a fancier
 * fit would extrapolate confidence the data does not carry. The slope is
 * reported alongside the date so the screen can say how fast, not just when.
 */
function fitDailySlope(
	points: readonly IndependenceDayPoint[]
): { slopePerDay: number; latestShare: number; usableDays: number } | null {
	const usable: { x: number; y: number }[] = [];
	let latestDay = Number.NEGATIVE_INFINITY;
	let latestShare = 0;
	for (const point of points) {
		const share = dayOwnShare(point);
		if (share === null) continue;
		usable.push({ x: point.day / DAY_MS, y: share });
		if (point.day >= latestDay) {
			latestDay = point.day;
			latestShare = share;
		}
	}
	if (usable.length < INDEPENDENCE_PROJECTION_MIN_DAYS) {
		return null;
	}
	const n = usable.length;
	let sumX = 0;
	let sumY = 0;
	for (const p of usable) {
		sumX += p.x;
		sumY += p.y;
	}
	const meanX = sumX / n;
	const meanY = sumY / n;
	let numerator = 0;
	let denominator = 0;
	for (const p of usable) {
		const dx = p.x - meanX;
		numerator += dx * (p.y - meanY);
		denominator += dx * dx;
	}
	// Every usable day landed on the same x — one day, reported several times.
	// There is no slope to read off a single column of points.
	if (denominator <= 0) return null;
	const slopePerDay = numerator / denominator;
	if (!Number.isFinite(slopePerDay)) return null;
	return { slopePerDay, latestShare, usableDays: n };
}

/**
 * The projected date the reference transport stops carrying mail.
 *
 * `hasReferenceTransport === false` short-circuits to `already_independent`
 * BEFORE any arithmetic: with no relay there is no spend to end and no date to
 * project, and that is the supported standalone configuration (plan D2), not a
 * missing measurement.
 */
export function projectIndependenceDate(input: {
	readonly points: readonly IndependenceDayPoint[];
	readonly now: number;
	readonly hasReferenceTransport: boolean;
}): IndependenceProjection {
	if (!input.hasReferenceTransport) return { kind: 'already_independent' };
	if (!Number.isFinite(input.now)) return { kind: 'insufficient_data', usableDays: 0 };
	const fit = fitDailySlope(input.points);
	if (fit === null) {
		const usableDays = input.points.filter((point) => dayOwnShare(point) !== null).length;
		return { kind: 'insufficient_data', usableDays };
	}
	if (fit.latestShare >= INDEPENDENCE_TARGET_SHARE) return { kind: 'already_independent' };
	if (fit.slopePerDay <= 0) return { kind: 'not_advancing' };
	const daysRemaining = (INDEPENDENCE_TARGET_SHARE - fit.latestShare) / fit.slopePerDay;
	if (!Number.isFinite(daysRemaining) || daysRemaining > INDEPENDENCE_PROJECTION_HORIZON_DAYS) {
		return { kind: 'beyond_horizon' };
	}
	return {
		kind: 'projected',
		at: input.now + Math.ceil(daysRemaining) * DAY_MS,
		dailyGainPp: fit.slopePerDay * 100,
	};
}

// ============ SPEND AVOIDED ============

/**
 * Money not spent, in the smallest currency unit, over the sends the own server
 * carried.
 *
 * A UNIT PRICE IS AN INPUT, NEVER A GUESS. Operators pay wildly different rates
 * and a number the product invented would be quoted back at us; when nobody has
 * told us a price the answer is `null` and the screen says so plainly instead of
 * printing a confident fiction.
 */
export function spendAvoidedMinorUnits(input: {
	readonly ownSends: number;
	readonly minorUnitsPerThousand: number | null;
}): number | null {
	const { ownSends, minorUnitsPerThousand } = input;
	// THE PRICE IS VALIDATED FIRST, and the order is the contract: a corrupt or
	// negative price is unanswerable at ANY volume, so it must not be able to
	// answer `0` just because the volume happens to be zero. `0` means "we know
	// the price and nothing was avoided"; `null` means "we cannot say".
	if (minorUnitsPerThousand === null) return null;
	if (!Number.isFinite(minorUnitsPerThousand) || minorUnitsPerThousand < 0) return null;
	if (!Number.isFinite(ownSends) || ownSends <= 0) return 0;
	return Math.round((ownSends / 1000) * minorUnitsPerThousand);
}

/** Own-arm sends on or after `sinceDay` — the month-to-date denominator. */
export function ownSendsSince(points: readonly IndependenceDayPoint[], sinceDay: number): number {
	if (!Number.isFinite(sinceDay)) return 0;
	let total = 0;
	for (const point of points) {
		if (!isUsablePoint(point)) continue;
		if (point.day < sinceDay) continue;
		total += point.own;
	}
	return total;
}

// ============ THE PRESETS (plan D9) ============

export const RAMP_PRESET_KEYS = ['conservative', 'balanced', 'aggressive'] as const;
export type RampPreset = (typeof RAMP_PRESET_KEYS)[number];

/**
 * WHAT A PRESET ACTUALLY CHANGES — a substitution over the shipped constant
 * table, never a second constant table.
 *
 * `balanced` IS THE SHIPPED BEHAVIOUR, exactly: scale 1, no extra windows. That
 * is what makes this additive — a deployment that never touches a preset is
 * running the same controller it ran yesterday, and the preset is a knob over
 * `RAMP_STREAM_CONFIGS` rather than a fork of it.
 *
 * The asymmetry is the plan's (D9): a preset may make the ADVANCE cheaper or
 * dearer and may never touch the RETREAT. Multiplicative decrease, the floor,
 * the cooldown ladder and every hard stop are outside a preset's reach by
 * construction — there is no field here that could express them.
 */
export interface RampPresetTuning {
	/** Multiplier on the stream's additive-increase step. */
	readonly increaseStepScale: number;
	/** Extra clean windows required on top of the stream's K_CLEAN. */
	readonly extraCleanWindows: number;
}

const RAMP_PRESET_TUNING: Record<RampPreset, RampPresetTuning> = {
	// `conservative` IS the plan's standalone substitution, not a coincidence
	// that happens to match it: step halved, K_CLEAN +2 (3 -> 5). Applying that
	// substitution anywhere else as well would compound it to x0.25 / K_CLEAN 7.
	conservative: { increaseStepScale: 0.5, extraCleanWindows: 2 },
	balanced: { increaseStepScale: 1, extraCleanWindows: 0 },
	aggressive: { increaseStepScale: 1.5, extraCleanWindows: 0 },
};

/**
 * The preset a stream runs under when nobody has chosen one.
 *
 * STANDALONE DEFAULTS TO CONSERVATIVE, and the reason is D14 rather than
 * timidity: with no reference arm the engagement gate is a genuinely weak
 * signal, so the honest response to weaker evidence is to advance more slowly —
 * not to advance at the same pace and hope.
 *
 * THIS IS THE PLAN'S STANDALONE SUBSTITUTION, AND ITS ONLY APPLICATION. The
 * substitution the plan describes — K_CLEAN 3 -> 5, step halved with no
 * reference transport — is precisely `RAMP_PRESET_TUNING.conservative`, so it is
 * delivered here rather than a second time inside the gate table. The resulting
 * standalone constants are fixture-pinned (K_CLEAN 5; campaign and automation
 * step 2.5pp; transactional step 1.5pp) so they cannot drift silently.
 *
 * A deployment WITH a relay defaults to `balanced`, which is the identity
 * tuning: it runs `RAMP_STREAM_CONFIGS` exactly as shipped.
 */
export function defaultRampPreset(hasReferenceTransport: boolean): RampPreset {
	return hasReferenceTransport ? 'balanced' : 'conservative';
}

/** Apply a preset to one stream's shipped constants. */
export function applyRampPreset(
	base: { readonly increaseStep: number; readonly cleanWindowsRequired: number },
	preset: RampPreset
): { readonly increaseStep: number; readonly cleanWindowsRequired: number } {
	const tuning = RAMP_PRESET_TUNING[preset];
	return {
		increaseStep: base.increaseStep * tuning.increaseStepScale,
		cleanWindowsRequired: base.cleanWindowsRequired + tuning.extraCleanWindows,
	};
}

// ============ THE CONSEQUENCE-NAMING CONFIRMATIONS ============

/**
 * THE TWO PHRASES A HUMAN MUST TYPE, and why they are values rather than prose
 * in a component.
 *
 * Force-advance and relay removal are the two actions in this product that can
 * lose reputation that took weeks to build, and neither may be reachable from a
 * single click. The phrase is checked SERVER-SIDE by the mutation and rendered
 * CLIENT-SIDE by the dialog, so it is defined once here: a dialog and a mutation
 * that disagree about the phrase is a confirmation that cannot be given.
 */
export const FORCE_ADVANCE_CONFIRMATION = 'ADVANCE WITHOUT EVIDENCE';
export const RELAY_REMOVAL_CONFIRMATION = 'REMOVE THE RELAY';

/**
 * Whether a typed confirmation matches. Trimmed and case-folded — a phrase
 * nobody can type because of a trailing space is theatre, not a safeguard —
 * but never fuzzy.
 */
export function isConfirmationPhraseMatch(typed: string, expected: string): boolean {
	return typed.trim().toLocaleUpperCase() === expected.toLocaleUpperCase();
}

// ============ RELAY REMOVAL SAFETY (a named plan mitigation) ============

/** A cell's ramp position, as much of it as the removal projection needs. */
export interface RelayRemovalCellState {
	readonly stream: DeliverabilityStream;
	readonly cellKey: string;
	readonly ownShare: number;
	readonly graduatedAt: number | undefined;
}

export type RelayRemovalSafety =
	| { readonly kind: 'safe' }
	| {
			readonly kind: 'unsafe';
			/** Cells still leaning on the relay, worst (lowest share) first. */
			readonly dependentCells: readonly string[];
			/** When every dependent cell would reach the target at the observed pace. */
			readonly projectedSafeAt: number | null;
	  };

/**
 * Is it safe to disconnect the reference transport, and if not, when will it be?
 *
 * "Safe" means every cell has GRADUATED (plan D9: s = 1.0 held 14 days with all
 * gates green). Anything short of that is a cell whose traffic the relay is
 * still absorbing, and pulling the relay does not move that traffic to the own
 * server gently — it moves all of it at once, which is the exact failure the
 * ramp exists to avoid. The projection is the shared one, so the date the
 * removal dialog quotes is the date the Independence screen quotes.
 */
export function assessRelayRemoval(input: {
	readonly cells: readonly RelayRemovalCellState[];
	readonly projection: IndependenceProjection;
}): RelayRemovalSafety {
	const dependent = input.cells
		.filter((cell) => cell.graduatedAt === undefined)
		.slice()
		.sort((a, b) => a.ownShare - b.ownShare);
	if (dependent.length === 0) return { kind: 'safe' };
	return {
		kind: 'unsafe',
		dependentCells: dependent.map((cell) => cell.cellKey),
		projectedSafeAt: input.projection.kind === 'projected' ? input.projection.at : null,
	};
}
