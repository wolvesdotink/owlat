/**
 * The key-authed v1 HTTP handler shell: body cap, the authenticated-handler
 * factory, and the per-endpoint scope gate.
 *
 * Split out of `auth/apiAuth.ts` (file-size ratchet). `createAuthenticatedHandler`
 * is the one door every v1 endpoint goes through — it authenticates
 * (`auth/apiKeyAuth.ts`), caps the body, runs the handler, and normalizes the
 * rate-limit/CORS headers on the way out.
 */
import { httpAction } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { corsHeaders as sharedCorsHeaders } from '../lib/cors';
import { logError } from '../lib/runtimeLog';
import type { OperationErrorCategory } from '@owlat/shared/operationError';
import type { ApiScope } from './apiScopes';
import { errorResponse, type RateLimitHeaders } from './apiResponses';
import { authenticateApiRequest, type AuthContext } from './apiKeyAuth';

/**
 * Maximum authenticated v1 request body size (100 KB). Mirrors the public
 * token-endpoint shell's cap (`lib/publicTokenEndpoint.ts`) so a key-authed
 * caller can't stream an unbounded body into an action (memory-DoS) — the authed
 * shell previously capped nothing.
 */
const MAX_BODY_BYTES = 100_000;

/** Methods that never carry a request body — the cap simply passes them through. */
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Buffer and size-cap the request body BEFORE the wrapped handler runs, so an
 * oversized body is rejected without the handler ever reading it. Bodyless
 * methods pass through untouched. On success the buffered bytes are re-wrapped in
 * a fresh `Request` (same method/url/headers) so the handler's own
 * `request.json()` still works. Returns the (possibly re-wrapped) request, or a
 * 400 Response when the body exceeds {@link MAX_BODY_BYTES}.
 */
export async function enforceBodyCap(
	request: Request,
	requestOrigin: string | null
): Promise<{ ok: true; request: Request } | { ok: false; response: Response }> {
	if (BODYLESS_METHODS.has(request.method.toUpperCase())) {
		return { ok: true, request };
	}
	// Cheap pre-check on the declared length (honest clients / oversized uploads).
	const contentLength = request.headers.get('Content-Length');
	if (contentLength && Number.parseInt(contentLength, 10) > MAX_BODY_BYTES) {
		return {
			ok: false,
			response: errorResponse('invalid_input', 'Request body too large', { requestOrigin }),
		};
	}
	// Buffer so a chunked body with no Content-Length can't stream past the cap.
	const raw = await request.arrayBuffer();
	if (raw.byteLength > MAX_BODY_BYTES) {
		return {
			ok: false,
			response: errorResponse('invalid_input', 'Request body too large', { requestOrigin }),
		};
	}
	return {
		ok: true,
		request:
			raw.byteLength === 0
				? request
				: new Request(request.url, {
						method: request.method,
						headers: request.headers,
						body: raw,
					}),
	};
}

/**
 * Helper type for authenticated HTTP action context
 */
export interface AuthenticatedContext {
	keyId: Id<'apiKeys'>;
	scopes: string[];
	rateLimit: RateLimitHeaders;
}

/**
 * Enforce that the authenticated key carries `scope`. Returns a 403 `forbidden`
 * Response when it does not, or `null` when the call is permitted — the v1
 * handlers call this at their top: `const denied = requireScope(auth, '...',
 * origin); if (denied) return denied;`.
 */
export function requireScope(
	auth: AuthenticatedContext,
	scope: ApiScope,
	requestOrigin?: string | null
): Response | null {
	if (auth.scopes.includes(scope)) return null;
	return errorResponse('forbidden', `This API key is missing the required scope: ${scope}`, {
		rateLimit: auth.rateLimit,
		requestOrigin,
	});
}

// Type for the full action context including runAction and storage
interface ActionContext extends AuthContext {
	runAction: <T>(action: unknown, args: unknown) => Promise<T>;
	storage: {
		store(blob: Blob): Promise<string>;
		getUrl(storageId: string): Promise<string | null>;
	};
}

/**
 * Create an authenticated HTTP action wrapper
 * This is a factory function that wraps an HTTP action with authentication
 */
export function createAuthenticatedHandler(
	handler: (ctx: ActionContext, request: Request, auth: AuthenticatedContext) => Promise<Response>
) {
	return httpAction(async (ctx, request) => {
		const origin = request.headers.get('Origin');

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					...sharedCorsHeaders(undefined, origin),
					'Access-Control-Max-Age': '86400',
				},
			});
		}

		// Authenticate the request
		const authResult = await authenticateApiRequest(ctx as unknown as AuthContext, request);
		if (!authResult.success) {
			const category: OperationErrorCategory =
				authResult.status === 429 ? 'rate_limited' : 'unauthenticated';
			return errorResponse(category, authResult.error, {
				retryAfter: authResult.retryAfter,
				rateLimit: authResult.rateLimit,
				requestOrigin: origin,
			});
		}

		// Cap the request body (authenticated callers only — auth reads headers,
		// not the body, so an unauthenticated flood never reaches this buffer).
		const capped = await enforceBodyCap(request, origin);
		if (!capped.ok) return capped.response;

		// Call the handler with authenticated context
		try {
			const response = await handler(ctx as unknown as ActionContext, capped.request, {
				keyId: authResult.keyId,
				scopes: authResult.scopes,
				rateLimit: authResult.rateLimit,
			});

			// Add rate limit and CORS headers to response
			const newHeaders = new Headers(response.headers);
			if (!newHeaders.has('X-RateLimit-Limit')) {
				newHeaders.set('X-RateLimit-Limit', String(authResult.rateLimit.limit));
				newHeaders.set('X-RateLimit-Remaining', String(authResult.rateLimit.remaining));
				newHeaders.set('X-RateLimit-Reset', String(authResult.rateLimit.reset));
			}

			// Ensure correct CORS origin on the response
			const corsH = sharedCorsHeaders(undefined, origin);
			for (const [key, value] of Object.entries(corsH)) {
				newHeaders.set(key, value);
			}

			return new Response(response.body, {
				status: response.status,
				headers: newHeaders,
			});
		} catch (error) {
			logError('API handler error:', error);
			return errorResponse('internal', 'Internal server error', {
				rateLimit: authResult.rateLimit,
				requestOrigin: origin,
			});
		}
	});
}
