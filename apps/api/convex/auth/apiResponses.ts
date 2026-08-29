/**
 * API-key posture HTTP response envelopes.
 *
 * Split out of `auth/apiAuth.ts` (file-size ratchet). These are the response
 * side of the key-authed v1 surface: they wrap the shared envelope builders in
 * `lib/httpResponse.ts` with the headers a session-less, key-authed response
 * needs (origin-aware CORS, rate-limit, retry-after).
 */
import { corsHeaders as sharedCorsHeaders } from '../lib/cors';
import {
	jsonResponse as libJsonResponse,
	errorResponse as libErrorResponse,
	methodNotAllowed as libMethodNotAllowed,
} from '../lib/httpResponse';
import type { OperationErrorCategory } from '@owlat/shared/operationError';

/**
 * Rate limit headers to include in responses
 */
export interface RateLimitHeaders {
	limit: number;
	remaining: number;
	reset: number;
}

/**
 * API-key posture JSON response — delegates envelope construction to
 * `lib/httpResponse.ts:jsonResponse` and composes the auth-specific headers
 * (origin-aware CORS, rate-limit, retry-after) here.
 *
 * The envelope shape lives in `lib/httpResponse.ts`; this wrapper exists only
 * to glue the headers a session-less, key-authed response needs.
 */
export function jsonResponse(
	data: unknown,
	status = 200,
	headers: Record<string, string> = {},
	rateLimit?: RateLimitHeaders,
	requestOrigin?: string | null
): Response {
	const composed: Record<string, string> = {
		...sharedCorsHeaders(undefined, requestOrigin),
		...headers,
	};
	if (rateLimit) {
		composed['X-RateLimit-Limit'] = String(rateLimit.limit);
		composed['X-RateLimit-Remaining'] = String(rateLimit.remaining);
		composed['X-RateLimit-Reset'] = String(rateLimit.reset);
	}
	return libJsonResponse(data, status, composed);
}

/**
 * API-key posture error response — the **HTTP adapter** at the Operation error
 * seam for key-authed endpoints. Delegates envelope + status to
 * `lib/httpResponse.ts:errorResponse` (status derived from `category`) and
 * composes the auth-specific headers (origin-aware CORS, rate-limit,
 * retry-after) here.
 */
export function errorResponse(
	category: OperationErrorCategory,
	message: string,
	opts?: {
		data?: Record<string, unknown>;
		retryAfter?: number;
		rateLimit?: RateLimitHeaders;
		requestOrigin?: string | null;
	}
): Response {
	const { data, retryAfter, rateLimit, requestOrigin } = opts ?? {};
	const composed: Record<string, string> = {
		...sharedCorsHeaders(undefined, requestOrigin),
	};
	if (rateLimit) {
		composed['X-RateLimit-Limit'] = String(rateLimit.limit);
		composed['X-RateLimit-Remaining'] = String(rateLimit.remaining);
		composed['X-RateLimit-Reset'] = String(rateLimit.reset);
	}
	if (retryAfter) {
		composed['Retry-After'] = String(retryAfter);
	}
	return libErrorResponse(category, message, data, composed);
}

/**
 * API-key posture 405 — composes origin-aware CORS around the shared
 * `methodNotAllowed`. Method routing is a transport concern, not an Operation
 * outcome, so it carries no category.
 */
export function methodNotAllowed(
	message = 'Method not allowed',
	requestOrigin?: string | null
): Response {
	return libMethodNotAllowed(message, sharedCorsHeaders(undefined, requestOrigin));
}
