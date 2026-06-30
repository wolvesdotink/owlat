/**
 * The **HTTP adapter** at the Operation error seam, plus the shared response
 * helpers consumed by both HTTP-shell factories: the **Public token endpoint
 * (module)** (`lib/publicTokenEndpoint.ts`) and the **API-key endpoint**
 * (`auth/apiAuth.ts:createAuthenticatedHandler`).
 *
 * One source for the locked error envelope shape:
 *
 *   `{ error: { category, message, data? } }`
 *
 * `errorResponse` derives the HTTP status *from* the `category` — one category,
 * one status, across every endpoint and matching the thrown (in-app) and SDK
 * serializations. See docs/adr/0036-operation-error-taxonomy.md.
 *
 * The CORS helper here is a typed wrapper over the lower-level
 * `lib/cors.ts:publicCorsHeaders` — it narrows the methods argument to the
 * union of method sets actually used by public token endpoints. The auth
 * posture (`auth/apiAuth.ts`) keeps using `lib/cors.ts:corsHeaders` directly
 * because it needs origin-aware allow-origin.
 *
 * See docs/adr/0030-public-token-endpoint-module.md.
 */

import {
	type OperationError,
	type OperationErrorCategory,
	categoryToHttpStatus,
	extractOperationError,
} from '@owlat/shared/operationError';
import { publicCorsHeaders as basePublicCorsHeaders } from './cors';

/**
 * Method sets accepted by public token endpoints. Restricted to keep
 * declarations honest — every public endpoint either reads or writes; the
 * `OPTIONS` preflight is owned by the shell.
 */
export type CorsMethodsHeader =
	| 'GET, OPTIONS'
	| 'POST, OPTIONS'
	| 'GET, POST, OPTIONS'
	| 'GET, POST, DELETE, OPTIONS';

/**
 * Typed wrapper over `lib/cors.publicCorsHeaders`. Public endpoints always
 * use `'*'` allow-origin; the union type just restricts the methods string.
 */
export function publicCorsHeaders(methods: CorsMethodsHeader): Record<string, string> {
	return basePublicCorsHeaders(methods);
}

/**
 * Build a JSON `Response`. Optionally merges in CORS (or any other) headers.
 */
export function jsonResponse(
	data: unknown,
	status = 200,
	corsHeaders: Record<string, string> | null = null,
): Response {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (corsHeaders) {
		Object.assign(headers, corsHeaders);
	}
	return new Response(JSON.stringify(data), {
		status,
		headers,
	});
}

/**
 * Build the locked error envelope: `{ error: { category, message, data? } }`,
 * with the HTTP status derived from the category. One shape and one
 * status-mapping for action-mode 4xx/5xx across every public token endpoint
 * and every API-key endpoint that returns a structured error.
 */
export function errorResponse(
	category: OperationErrorCategory,
	message: string,
	data?: Record<string, unknown>,
	corsHeaders: Record<string, string> | null = null,
): Response {
	const error: OperationError = { category, message };
	if (data !== undefined) error.data = data;
	return jsonResponse({ error }, categoryToHttpStatus(category), corsHeaders);
}

/**
 * Serialize a caught throw as an HTTP Operation error — the HTTP-side mirror of
 * the `apps/web` Operation module's normalize step. A `ConvexError` carrying an
 * Operation error keeps its category (and HTTP status); anything else collapses
 * to `internal` (500). Catch blocks in HTTP handlers that re-surface a thrown
 * backend failure use this instead of guessing a status.
 */
export function errorResponseFromThrow(
	e: unknown,
	corsHeaders: Record<string, string> | null = null,
): Response {
	const op = extractOperationError(e);
	if (op) {
		return errorResponse(op.category, op.message, op.data, corsHeaders);
	}
	const message = e instanceof Error ? e.message : 'Internal error';
	return errorResponse('internal', message, undefined, corsHeaders);
}

/**
 * A 405 response for an unsupported HTTP method. Method routing is a
 * transport concern, not an Operation outcome — there is no Operation error
 * category for it — so this is a small dedicated helper rather than a
 * `category`. The body keeps the `error` envelope for consistency but omits
 * `category`.
 */
export function methodNotAllowed(
	message = 'Method not allowed',
	corsHeaders: Record<string, string> | null = null,
): Response {
	return jsonResponse({ error: { message } }, 405, corsHeaders);
}
