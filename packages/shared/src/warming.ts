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
