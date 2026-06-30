/**
 * The one vocabulary for "an operation could not complete," shared across the
 * thrown (in-app), HTTP, and SDK seams. This module is the single definition
 * of the category union and its HTTP-status mapping; the Convex backend
 * (`_utils/errors.ts`) and the `apps/web` Operation modules both import it.
 *
 * See docs/adr/0036-operation-error-taxonomy.md and CONTEXT.md `## Operation errors`.
 */

/**
 * The closed classification of an Operation error. One category per failure;
 * it fixes both the HTTP status (across all three serializations) and the UI
 * treatment (via the Operation module). New failure modes fold into an existing
 * category and explain themselves in `message`/`data` — never a new category.
 *
 * `network` is client-only: a transport failure (fetch error / Convex
 * disconnect) never originates server-side.
 */
export type OperationErrorCategory =
	| 'unauthenticated'
	| 'forbidden'
	| 'not_found'
	| 'invalid_input'
	| 'already_exists'
	| 'conflict'
	| 'invalid_state'
	| 'rate_limited'
	| 'limit_reached'
	| 'internal'
	| 'network';

/**
 * The canonical failure shape every seam serializes. Specifics that used to be
 * bespoke codes ride in `data` — `{ field }`, `{ limit, used }`,
 * `{ retryAfter }`, a content-scan result — never as a new category.
 */
export interface OperationError {
	category: OperationErrorCategory;
	message: string;
	data?: Record<string, unknown>;
}

/**
 * Every category, as a runtime array. The lint guard and the runtime type
 * guards below derive from this so the union has exactly one source.
 */
export const OPERATION_ERROR_CATEGORIES = [
	'unauthenticated',
	'forbidden',
	'not_found',
	'invalid_input',
	'already_exists',
	'conflict',
	'invalid_state',
	'rate_limited',
	'limit_reached',
	'internal',
	'network',
] as const satisfies readonly OperationErrorCategory[];

/**
 * Category → HTTP status. Drives `errorResponse` on the HTTP seam and the
 * status→subclass selection in the SDKs. `network` is client-only and never
 * emitted as an HTTP body; it maps to 503 only to keep the record total.
 */
const CATEGORY_HTTP_STATUS: Record<OperationErrorCategory, number> = {
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	invalid_input: 400,
	already_exists: 409,
	conflict: 409,
	invalid_state: 422,
	rate_limited: 429,
	limit_reached: 402,
	internal: 500,
	network: 503,
};

/**
 * Resolve the HTTP status for a category.
 */
export function categoryToHttpStatus(category: OperationErrorCategory): number {
	return CATEGORY_HTTP_STATUS[category];
}

/**
 * Narrow an arbitrary string to a known category.
 */
export function isOperationErrorCategory(value: unknown): value is OperationErrorCategory {
	return (
		typeof value === 'string' &&
		(OPERATION_ERROR_CATEGORIES as readonly string[]).includes(value)
	);
}

/**
 * Structural guard: is `value` an Operation error payload (a closed `category`
 * plus a string `message`)? Used by the Operation modules to tell a categorized
 * backend throw apart from an opaque transport/runtime failure.
 */
export function isOperationError(value: unknown): value is OperationError {
	if (value === null || typeof value !== 'object') return false;
	const candidate = value as Record<string, unknown>;
	return (
		isOperationErrorCategory(candidate['category']) && typeof candidate['message'] === 'string'
	);
}

/**
 * Pull an Operation error out of a caught throw, returning `null` when the
 * value carries none. A `ConvexError` surfaces its payload on `.data`, so a
 * categorized backend throw appears either as the payload itself or nested one
 * level under `.data`. The HTTP adapter and the `apps/web` Operation modules
 * both use this to decide between honoring a categorized failure and falling
 * back to `internal`/`network`.
 */
export function extractOperationError(value: unknown): OperationError | null {
	if (isOperationError(value)) return value;
	if (value !== null && typeof value === 'object') {
		const data = (value as Record<string, unknown>)['data'];
		if (isOperationError(data)) return data;
	}
	return null;
}
