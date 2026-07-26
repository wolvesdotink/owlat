/**
 * IP-warming schedule — the single source of truth shared by the MTA (which
 * ENFORCES the per-IP daily send cap) and the Convex backend (which projects
 * caps for the warming dashboard). Forking these previously let the two drift
 * (the copies already disagreed at the graduated stage).
 *
 * `cap: Infinity` at the graduated stage means "no warming cap" — the MTA stops
 * throttling. Where a finite number is needed (UI projections, stored aggregates
 * that can't hold Infinity), use GRADUATED_DISPLAY_CAP / getWarmingDisplayCapForDay.
 */
export const BASE_WARMING_SCHEDULE: ReadonlyArray<{ day: number; cap: number }> = [
	{ day: 1, cap: 50 },
	{ day: 2, cap: 100 },
	{ day: 3, cap: 200 },
	{ day: 5, cap: 700 },
	{ day: 7, cap: 1500 },
	{ day: 10, cap: 3000 },
	{ day: 14, cap: 7500 },
	{ day: 18, cap: 15000 },
	{ day: 21, cap: 20000 },
	{ day: 25, cap: 30000 },
	{ day: 30, cap: Infinity }, // graduated — no warming cap
];

/**
 * Finite ceiling substituted for the graduated Infinity wherever a real number
 * is required (dashboard projections, numeric DB columns).
 */
export const GRADUATED_DISPLAY_CAP = 200_000;

/** Last schedule cap that can be enforced before health-gated graduation. */
export const LAST_FINITE_WARMING_CAP = BASE_WARMING_SCHEDULE.reduce(
	(lastFiniteCap, entry) => (Number.isFinite(entry.cap) ? entry.cap : lastFiniteCap),
	BASE_WARMING_SCHEDULE[0]!.cap
);

/**
 * Adaptive warming policy enforced by the MTA.
 *
 * This lives beside the base schedule so operational documentation and other
 * consumers can use the same named policy instead of copying numeric literals.
 * All rate boundaries are fractions (for example, 0.01 means 1%).
 */
export const ADAPTIVE_WARMING_POLICY = {
	acceleration: {
		bounceRateExclusiveMax: 0.01,
		deferralRateExclusiveMax: 0.05,
		usageRateMinimum: 0.8,
		scheduleDayMultiplier: 1.5,
	},
	deceleration: {
		bounceRateExclusiveMin: 0.03,
		deferralRateExclusiveMin: 0.1,
		scheduleDayMultiplier: 0.5,
		capMultiplier: 0.7,
		minimumCap: 50,
	},
	halt: {
		bounceRateExclusiveMin: 0.08,
		deferralRateExclusiveMin: 0.25,
	},
	graduation: {
		minimumScheduleDay: 30,
		bounceRateExclusiveMax: 0.02,
	},
} as const;

/** The enforced daily send cap for a warming day (Infinity once graduated). */
export function getWarmingCapForDay(day: number): number {
	let cap = BASE_WARMING_SCHEDULE[0]!.cap;
	for (const entry of BASE_WARMING_SCHEDULE) {
		if (entry.day <= day) cap = entry.cap;
		else break;
	}
	return cap;
}

/** Display-safe cap: the graduated Infinity is clamped to GRADUATED_DISPLAY_CAP. */
export function getWarmingDisplayCapForDay(day: number): number {
	const cap = getWarmingCapForDay(day);
	return Number.isFinite(cap) ? cap : GRADUATED_DISPLAY_CAP;
}
