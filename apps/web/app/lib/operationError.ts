/**
 * Frontend half of the Operation error seam (ADR-0036): turn any throw from a
 * backend call into the shared `{ category, message, data? }` vocabulary, and
 * map a category to its UI treatment. Pure functions — the Operation module
 * (`useBackendOperation`) layers the Vue/PostHog/toast plumbing on top, and
 * these stay unit-testable without mounting anything.
 */

import {
	type OperationError,
	type OperationErrorCategory,
	extractOperationError,
} from '@owlat/shared/operationError';

export type ErrorSurface = 'toast' | 'inline' | 'redirect';

export interface CategoryTreatment {
	/** Where the failure shows up in the UI. */
	surface: ErrorSurface;
	/** Whether the genuine-fault path reports to telemetry. */
	report: boolean;
	/**
	 * User-facing copy that overrides the backend `message`. Set only where the
	 * raw message is unhelpful or unsafe to show (a generic 500, a dropped
	 * connection, an expired session); elsewhere the backend message is the
	 * detail the user needs.
	 */
	genericCopy?: string;
}

/**
 * The category → treatment table from ADR-0036. The single policy both
 * Operation modules consult.
 */
const TREATMENT: Record<OperationErrorCategory, CategoryTreatment> = {
	unauthenticated: {
		surface: 'redirect',
		report: false,
		genericCopy: 'Your session has expired. Please sign in again.',
	},
	forbidden: { surface: 'toast', report: false },
	not_found: { surface: 'toast', report: false },
	invalid_input: { surface: 'inline', report: false },
	already_exists: { surface: 'inline', report: false },
	conflict: { surface: 'toast', report: false },
	invalid_state: { surface: 'toast', report: false },
	rate_limited: { surface: 'toast', report: false },
	limit_reached: { surface: 'toast', report: false },
	internal: {
		surface: 'toast',
		report: true,
		genericCopy: 'Something went wrong. Please try again.',
	},
	network: {
		surface: 'toast',
		report: true,
		genericCopy: 'Connection problem. Check your network and try again.',
	},
};

/**
 * The UI treatment for a category.
 */
export function categoryTreatment(category: OperationErrorCategory): CategoryTreatment {
	return TREATMENT[category];
}

/**
 * Heuristic: is this throw a transport failure (a dropped fetch / Convex
 * disconnect) rather than a categorized backend error or a runtime bug? Drives
 * the `network` vs `internal` split for uncategorized throws.
 */
export function isTransportFailure(e: unknown): boolean {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
	const message = (e instanceof Error ? e.message : String(e)).toLowerCase();
	return (
		(e instanceof TypeError && message.includes('fetch')) ||
		message.includes('failed to fetch') ||
		message.includes('network') ||
		message.includes('connection') ||
		message.includes('offline') ||
		message.includes('websocket') ||
		message.includes('timed out') ||
		message.includes('timeout')
	);
}

/**
 * Normalize any throw into an Operation error. A `ConvexError` carrying the
 * Operation error payload keeps its category; a transport failure becomes
 * `network`; anything else collapses to `internal`.
 */
export function normalizeToOperationError(e: unknown): OperationError {
	const op = extractOperationError(e);
	if (op) return op;
	if (isTransportFailure(e)) {
		return { category: 'network', message: e instanceof Error ? e.message : 'Network error' };
	}
	return { category: 'internal', message: e instanceof Error ? e.message : String(e) };
}

/**
 * The copy to show the user: the category's generic override where one exists,
 * otherwise the backend message (falling back to a generic line if empty).
 */
export function operationCopy(op: OperationError): string {
	const treatment = TREATMENT[op.category];
	return treatment.genericCopy ?? (op.message || 'Something went wrong. Please try again.');
}
