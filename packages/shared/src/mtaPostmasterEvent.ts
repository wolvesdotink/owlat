/**
 * The Google Postmaster Tools half of the MTA webhook wire contract.
 *
 * Split out of `mtaWebhookEvent.ts` for size (CONVENTIONS' ~500 LOC guideline);
 * that module re-exports every name below, so it stays the one import surface
 * for the wire and no consumer has to know about the seam.
 *
 * One definition of the shapes and of the sanitization bounds, imported by the
 * MTA collector and by the Convex ingest. Each end still re-VALIDATES at its
 * own trust boundary; what must never drift is the numbers it validates
 * against — a collector that kept more checks than this guard accepts would
 * have the whole event rejected and the day's verdict silently lost.
 */

/** One Compliance Status check as Google reports it, normalized. */
export interface PostmasterComplianceCheck {
	name: string;
	state: 'passing' | 'failing' | 'unknown';
}

/** One delivery-error category's share of a domain's traffic for a day. */
export interface PostmasterDeliveryError {
	category: string;
	ratio: number;
}

/**
 * The only shape a Postmaster check name or delivery-error category may take.
 * Both are stored and rendered verbatim, so anything else is DROPPED rather
 * than escaped.
 */
export const POSTMASTER_TOKEN = /^[A-Z0-9_]{1,64}$/;
/** Upper bound on the Compliance Status checks carried for one domain/day. */
export const POSTMASTER_MAX_COMPLIANCE_CHECKS = 32;
/** Upper bound on the delivery-error categories carried for one domain/day. */
export const POSTMASTER_MAX_DELIVERY_ERROR_CATEGORIES = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ratio(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Bounded `{ category, ratio }` list — the Postmaster delivery-error breakdown. */
export function isDeliveryErrorBreakdown(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= POSTMASTER_MAX_DELIVERY_ERROR_CATEGORIES &&
		value.every(
			(item) =>
				isRecord(item) &&
				typeof item['category'] === 'string' &&
				POSTMASTER_TOKEN.test(item['category']) &&
				ratio(item['ratio'])
		)
	);
}

/**
 * Bounded Compliance Status checks with enum-shaped names. An EMPTY list is
 * well-formed here: `checks` rides on the webhook event BASE for every event kind,
 * so it is bounded at the top level for all of them and only the
 * `postmaster.compliance` case additionally requires a non-empty verdict.
 */
export function isComplianceChecks(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= POSTMASTER_MAX_COMPLIANCE_CHECKS &&
		value.every(
			(item) =>
				isRecord(item) &&
				typeof item['name'] === 'string' &&
				POSTMASTER_TOKEN.test(item['name']) &&
				(item['state'] === 'passing' || item['state'] === 'failing' || item['state'] === 'unknown')
		)
	);
}
