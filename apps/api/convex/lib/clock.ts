/**
 * Clock helpers — dependency-free by design.
 *
 * This module imports NOTHING: no `convex/values`, no `_generated/*`, no other
 * convex module. That is the whole point. `startOfDayUtc` used to live in
 * `analytics/sendingReputation.ts`, a Convex FUNCTION module that registers
 * mutations and pulls in the generated API graph, so every "pure core" module
 * that only wanted the day-bucket arithmetic dragged that graph in behind it.
 * Put day/clock primitives here and import them from here.
 */

/** Start-of-day timestamp (midnight UTC) for a given time. */
export function startOfDayUtc(epochMs: number): number {
	const d = new Date(epochMs);
	d.setUTCHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Normalize an optional caller-supplied clock to a usable timestamp.
 *
 * Convex numbers are float64, so `NaN`/`Infinity` are valid arguments to any
 * `v.optional(v.number())` clock parameter. Letting one through turns a cutoff
 * into `NaN` and a retention sweep into a silent permanent no-op, so a
 * non-finite candidate falls back to the real clock exactly as an absent one
 * does.
 */
export function resolveNow(candidate: number | undefined): number {
	return candidate !== undefined && Number.isFinite(candidate) ? candidate : Date.now();
}
