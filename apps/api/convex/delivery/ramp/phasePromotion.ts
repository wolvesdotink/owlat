/**
 * CROSSING THE 0.5 CEILING (plan D3's promotion rule) — the either/or as DATA.
 *
 * The plan states it as a sentence with an "either ... or" in the middle:
 * promotion past the 0.5 rung requires EITHER a Google Compliance Status pass
 * (Gmail) or an SNDS complaint band green (Microsoft) for the relevant cell
 * within the last 7 days, OR — standalone — ALL FOUR of a doubled dwell, a
 * recent passing seed probe, a 14-consecutive-day DNSBL-clean streak across
 * every pool IP, and a deferral rate under threshold in EVERY cell.
 *
 * IMPLEMENTED AS ROUTES, NOT AS BRANCHING. A route is a named list of
 * conditions; promotion is allowed when ANY route's conditions are all met. Two
 * `if`s in a row would encode the same rule and would be the exact shape this
 * piece exists to eliminate — a third promotion path (a future integration)
 * would then be a third `if` rather than a fourth row.
 *
 * PURE (plan D15): the clock, the evidence and the target rung are parameters.
 *
 * D2 STILL HOLDS. No route is reachable only with an external account: the
 * standalone route exists precisely so a deployment with zero third-party
 * credentials can reach 1.0 — slower, on corroborated self-hosted evidence.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** External evidence older than this is not evidence — the plan's 7 days. */
export const PROMOTION_EVIDENCE_MAX_AGE_MS = 7 * DAY_MS;

/** The plan's "14 CONSECUTIVE days across EVERY pool IP". */
export const PROMOTION_DNSBL_CLEAN_DAYS = 14;

/** The plan's "2x the normal dwell time at the current ceiling". */
export const PROMOTION_STANDALONE_DWELL_MULTIPLE = 2;

/**
 * The NORMAL dwell at a rung, before any multiplier. One week — the width of the
 * shortest window any promotion evidence is judged over, so a rung can never be
 * promoted out of on evidence thinner than the evidence that justified it.
 */
export const PROMOTION_BASE_DWELL_MS = 7 * DAY_MS;

/**
 * The rung above which external-or-corroborated evidence is required. Stated as
 * "crossing the 0.5 ceiling": a target ABOVE 0.5 crosses it, promotion TO 0.5
 * does not. Below it the ordinary AIMD ladder governs and no route is consulted.
 */
export const PROMOTION_EVIDENCE_REQUIRED_ABOVE = 0.5;

export const PROMOTION_CONDITION_IDS = [
	'google_compliance_pass',
	'snds_complaint_band_green',
	'dwell_multiple_served',
	'seed_probe_pass_recent',
	'dnsbl_clean_streak',
	'deferral_under_threshold_all_cells',
] as const;

export type PromotionConditionId = (typeof PROMOTION_CONDITION_IDS)[number];

/**
 * THREE-VALUED ON PURPOSE. "We cannot tell" is not "fine": an unmeasurable
 * condition is `unknown`, is reported by name, and never counts as met. A
 * boolean would fold the two together and promote a cell on evidence nobody has.
 */
export type PromotionConditionState = 'met' | 'unmet' | 'unknown';

export type PromotionConditions = Readonly<Record<PromotionConditionId, PromotionConditionState>>;

export interface PromotionRoute {
	readonly id: 'google_compliance' | 'snds_band' | 'standalone_corroboration';
	readonly label: string;
	/** Providers this route can speak for; `'all'` for the standalone route. */
	readonly scope: 'all' | readonly DestinationProviderKey[];
	readonly conditions: readonly PromotionConditionId[];
}

/**
 * THE ROUTES. Any one of them, fully met, permits the promotion.
 *
 * The two external routes are single-condition and provider-scoped; the
 * standalone route is the plan's four conditions, all of which are measured on
 * our own infrastructure.
 */
export const PROMOTION_ROUTES: readonly PromotionRoute[] = [
	{
		id: 'google_compliance',
		label: 'Google Postmaster Compliance Status passing in the last 7 days',
		scope: ['gmail'],
		conditions: ['google_compliance_pass'],
	},
	{
		id: 'snds_band',
		label: 'Microsoft SNDS complaint band green in the last 7 days',
		scope: ['microsoft'],
		conditions: ['snds_complaint_band_green'],
	},
	{
		id: 'standalone_corroboration',
		label: 'corroborated self-hosted evidence',
		scope: 'all',
		conditions: [
			'dwell_multiple_served',
			'seed_probe_pass_recent',
			'dnsbl_clean_streak',
			'deferral_under_threshold_all_cells',
		],
	},
];

/** One UTC day of pool-wide DNSBL observation. */
export interface DnsblDayObservation {
	/** Start of the UTC day. */
	readonly dayStart: number;
	/** True only when EVERY pool IP was clean that day. */
	readonly clean: boolean;
}

/**
 * The longest run of consecutive clean days ending at the most recent
 * observation — ONE dirty day resets it to zero, which is the whole point of
 * asking for a streak rather than a percentage.
 *
 * A GAP IS A RESET TOO. Days are matched by their UTC day start, so a missing
 * day in the middle of the run breaks it: a streak assembled from days we did
 * not observe is not a streak, and the promotion it would unlock is the most
 * expensive one the ladder has.
 */
export function dnsblCleanStreakDays(days: readonly DnsblDayObservation[]): number {
	const sorted = [...days].sort((a, b) => b.dayStart - a.dayStart);
	let streak = 0;
	let expected: number | null = null;
	for (const day of sorted) {
		if (!Number.isFinite(day.dayStart)) return streak;
		if (expected !== null && day.dayStart !== expected) return streak;
		if (!day.clean) return streak;
		streak += 1;
		expected = day.dayStart - DAY_MS;
	}
	return streak;
}

/** The raw evidence a promotion is judged on. Instants, not verdicts. */
export interface RampPromotionEvidence {
	/** Latest instant Google reported every compliance check passing, or null. */
	readonly googleCompliancePassAt: number | null;
	/** Latest instant the SNDS complaint band was green, or null. */
	readonly sndsBandGreenAt: number | null;
	/** Latest instant a seed placement probe passed, or null. */
	readonly seedProbePassAt: number | null;
	/** How long the cell has held its CURRENT rung, or null when unknown. */
	readonly ceilingHeldMs: number | null;
	/** The dwell this cell owes at a rung, degradation multipliers already applied. */
	readonly requiredDwellMs: number;
	/** Pool-wide DNSBL observations, newest-first or in any order. */
	readonly dnsblDays: readonly DnsblDayObservation[];
	/** The WORST deferral rate across EVERY cell, or null when unmeasured. */
	readonly worstCellDeferralRate: number | null;
	/** The deferral ceiling that rate is judged against, as a fraction. */
	readonly deferralMax: number;
}

function withinWindow(at: number | null, now: number): PromotionConditionState {
	if (at === null || !Number.isFinite(at) || !Number.isFinite(now)) return 'unknown';
	// EVIDENCE FROM THE FUTURE IS NOT EVIDENCE. A skewed clock must not be able
	// to manufacture a fresh pass, so ahead-of-now reads as unmeasurable.
	if (at > now) return 'unknown';
	return now - at <= PROMOTION_EVIDENCE_MAX_AGE_MS ? 'met' : 'unmet';
}

/**
 * Turn the raw evidence into the six condition states. Pure and total: every
 * condition gets a state for every input, and anything unreadable is `unknown`.
 */
export function derivePromotionConditions(
	evidence: RampPromotionEvidence,
	now: number
): PromotionConditions {
	const dwellRequired = evidence.requiredDwellMs * PROMOTION_STANDALONE_DWELL_MULTIPLE;
	const heldMs = evidence.ceilingHeldMs;
	const dwell: PromotionConditionState =
		heldMs === null || !Number.isFinite(heldMs) || !Number.isFinite(dwellRequired)
			? 'unknown'
			: heldMs >= dwellRequired
				? 'met'
				: 'unmet';

	const streak = dnsblCleanStreakDays(evidence.dnsblDays);
	// COVERAGE IS PART OF THE CONDITION. Fewer observed days than the streak
	// demands is not a short streak, it is a window we did not watch — `unknown`,
	// never a pass.
	const dnsbl: PromotionConditionState =
		evidence.dnsblDays.length < PROMOTION_DNSBL_CLEAN_DAYS
			? 'unknown'
			: streak >= PROMOTION_DNSBL_CLEAN_DAYS
				? 'met'
				: 'unmet';

	const worst = evidence.worstCellDeferralRate;
	const deferral: PromotionConditionState =
		worst === null || !Number.isFinite(worst) || !Number.isFinite(evidence.deferralMax)
			? 'unknown'
			: worst <= evidence.deferralMax
				? 'met'
				: 'unmet';

	return {
		google_compliance_pass: withinWindow(evidence.googleCompliancePassAt, now),
		snds_complaint_band_green: withinWindow(evidence.sndsBandGreenAt, now),
		dwell_multiple_served: dwell,
		seed_probe_pass_recent: withinWindow(evidence.seedProbePassAt, now),
		dnsbl_clean_streak: dnsbl,
		deferral_under_threshold_all_cells: deferral,
	};
}

export interface PromotionRouteResult {
	readonly route: PromotionRoute;
	readonly satisfied: boolean;
	/** Conditions that are not `met`, with the state that stopped them. */
	readonly outstanding: readonly {
		readonly condition: PromotionConditionId;
		readonly state: PromotionConditionState;
	}[];
}

export interface PhasePromotionDecision {
	readonly allowed: boolean;
	/** Which route permitted it — `null` when none did or none was needed. */
	readonly viaRoute: PromotionRoute['id'] | null;
	/** True when the target rung is low enough that no route was consulted. */
	readonly evidenceRequired: boolean;
	/** Every applicable route with its outstanding conditions, for the UI. */
	readonly routes: readonly PromotionRouteResult[];
}

function routeApplies(route: PromotionRoute, provider: DestinationProviderKey): boolean {
	return route.scope === 'all' || route.scope.includes(provider);
}

/**
 * May this cell be promoted to `targetCeiling`?
 *
 * Below the 0.5 line no evidence is required and the answer is yes — the phase
 * ladder's lower rungs are the ordinary ramp. Above it, ANY applicable route
 * whose conditions are all met permits the promotion, and the result always
 * carries every route's outstanding conditions so the screen can name what is
 * missing instead of saying no.
 */
export function evaluatePhasePromotion(args: {
	readonly targetCeiling: number;
	readonly provider: DestinationProviderKey;
	readonly evidence: RampPromotionEvidence;
	readonly now: number;
}): PhasePromotionDecision {
	const { targetCeiling, provider, evidence, now } = args;
	const evidenceRequired =
		Number.isFinite(targetCeiling) && targetCeiling > PROMOTION_EVIDENCE_REQUIRED_ABOVE;
	const conditions = derivePromotionConditions(evidence, now);
	const routes: PromotionRouteResult[] = PROMOTION_ROUTES.filter((route) =>
		routeApplies(route, provider)
	).map((route) => {
		const outstanding = route.conditions
			.map((condition) => ({ condition, state: conditions[condition] }))
			.filter((entry) => entry.state !== 'met');
		return { route, satisfied: outstanding.length === 0, outstanding };
	});

	if (!evidenceRequired) {
		return { allowed: true, viaRoute: null, evidenceRequired: false, routes };
	}
	const satisfied = routes.find((result) => result.satisfied);
	return {
		allowed: satisfied !== undefined,
		viaRoute: satisfied?.route.id ?? null,
		evidenceRequired: true,
		routes,
	};
}
