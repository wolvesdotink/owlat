/**
 * Well-known tracking/redirect query parameters for Postbox link hygiene.
 *
 * Pure DATA file — the rewrite logic lives in `postboxLinkTransparency.ts`.
 * These parameters only feed analytics attribution; removing them never
 * changes which page a link resolves to (host + path stay untouched).
 *
 * The list is intentionally small and conservative: a miss is harmless (the
 * link still works, just with the tracking crumb attached), while a false
 * positive could break a legitimate link — so favor precision over recall.
 */

/** Exact (case-insensitive) tracking parameter names. */
export const TRACKING_PARAM_NAMES: readonly string[] = [
	// Facebook / Google / Mailchimp click identifiers
	'fbclid',
	'gclid',
	'mc_eid',
];

/** Case-insensitive prefixes: any param starting with one of these is tracking. */
export const TRACKING_PARAM_PREFIXES: readonly string[] = [
	// Google Analytics campaign attribution (utm_source, utm_medium, ...)
	'utm_',
];

/** True when a query parameter name is a known tracking parameter. */
export function isTrackingParamName(name: string): boolean {
	const lower = name.toLowerCase();
	if (TRACKING_PARAM_NAMES.includes(lower)) return true;
	return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
