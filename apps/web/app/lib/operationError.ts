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

/** The line shown when nothing more specific can be said. */
const GENERIC_COPY_KEY = 'shared.operationError.generic';

export interface CategoryTreatment {
	/** Where the failure shows up in the UI. */
	surface: ErrorSurface;
	/** Whether the genuine-fault path reports to telemetry. */
	report: boolean;
	/**
	 * MESSAGE KEY for user-facing copy that overrides the backend `message`. Set
	 * only where the raw message is unhelpful or unsafe to show (a generic 500, a
	 * dropped connection, an expired session); elsewhere the backend message is
	 * the detail the user needs.
	 *
	 * A key rather than a sentence because this table is module scope — it cannot
	 * call `useI18n`, so the render boundary resolves it.
	 */
	genericCopyKey?: string;
}

/**
 * The category → treatment table from ADR-0036. The single policy both
 * Operation modules consult.
 */
const TREATMENT: Record<OperationErrorCategory, CategoryTreatment> = {
	unauthenticated: {
		surface: 'redirect',
		report: false,
		genericCopyKey: 'shared.operationError.sessionExpired',
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
		genericCopyKey: GENERIC_COPY_KEY,
	},
	network: {
		surface: 'toast',
		report: true,
		genericCopyKey: 'shared.operationError.network',
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
 * What to show the user, in the two forms it can take: a catalog KEY for copy
 * this app owns, or the backend's own `message` text, which is already a
 * sentence and has no key to look up.
 */
export type OperationCopy = { key: string } | { text: string };

/**
 * The copy to show the user: the category's generic override where one exists,
 * otherwise the backend message (falling back to a generic line if empty).
 *
 * Module scope — no `useI18n` here. The two forms are kept apart rather than
 * collapsed into one string because a backend message must NOT be run through
 * `t()`: it is arbitrary text (an address, a template name) and the message
 * compiler reads characters like `@` as syntax.
 */
export function operationCopy(op: OperationError): OperationCopy {
	const treatment = TREATMENT[op.category];
	if (treatment.genericCopyKey) return { key: treatment.genericCopyKey };
	return op.message ? { text: op.message } : { key: GENERIC_COPY_KEY };
}

/** Resolve {@link operationCopy} at a render boundary that holds a `t`. */
export function resolveOperationCopy(
	copy: OperationCopy,
	translate: (key: string) => string
): string {
	return 'text' in copy ? copy.text : translate(copy.key);
}
