import { httpAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { v } from 'convex/values';
import { rateLimiter } from '../rateLimiter';
import { corsHeaders as sharedCorsHeaders } from '../lib/cors';
import { logError } from '../lib/runtimeLog';
import {
	jsonResponse as libJsonResponse,
	errorResponse as libErrorResponse,
	methodNotAllowed as libMethodNotAllowed,
} from '../lib/httpResponse';
import type { OperationErrorCategory } from '@owlat/shared/operationError';
import type { ApiScope } from './apiScopes';

// Rate limiting configuration
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per second

/**
 * Hash an API key using SHA-256. Shared with the key-management path
 * (`auth/apiKeys.ts:create`) so the storage hash and the lookup hash can never
 * diverge.
 */
export async function hashApiKey(key: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(key);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether a stored API key may still authenticate a request. A key is usable
 * only while it is active AND (if a hard expiry is set) that expiry is still in
 * the future. Extracted as a pure helper so the enforcement rule is testable
 * without the rate-limiter component.
 */
export function isApiKeyUsable(
	key: { isActive: boolean; expiresAt?: number },
	now: number = Date.now()
): boolean {
	if (!key.isActive) return false;
	if (key.expiresAt !== undefined && key.expiresAt <= now) return false;
	return true;
}

/**
 * Rate limit headers to include in responses
 */
export interface RateLimitHeaders {
	limit: number;
	remaining: number;
	reset: number;
}

/**
 * API authentication result
 */
export interface ApiAuthResult {
	success: true;
	keyId: Id<'apiKeys'>;
	scopes: string[];
	rateLimit: RateLimitHeaders;
}

export interface ApiAuthError {
	success: false;
	error: string;
	status: number;
	retryAfter?: number;
	rateLimit?: RateLimitHeaders;
}

export type ApiAuthResponse = ApiAuthResult | ApiAuthError;

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

/**
 * Extract and validate API key from Authorization header
 */
export function extractApiKey(request: Request): string | null {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader) {
		return null;
	}

	// Support both "Bearer <token>" and just "<token>"
	const parts = authHeader.split(' ');
	if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer') {
		return parts[1] ?? null;
	}
	if (parts.length === 1) {
		return parts[0] ?? null;
	}

	return null;
}

// Type for the context object used in authentication

interface AuthContext {
	runQuery: <T>(query: unknown, args: unknown) => Promise<T>;
	runMutation: <T>(mutation: unknown, args: unknown) => Promise<T>;
}

/**
 * Authenticate an API request using the provided API key
 * Returns team ID and key ID if successful, or error details
 */
export async function authenticateApiRequest(
	ctx: AuthContext,
	request: Request
): Promise<ApiAuthResponse> {
	// Extract API key from Authorization header
	const apiKey = extractApiKey(request);
	if (!apiKey) {
		return {
			success: false,
			error: 'Missing or invalid Authorization header. Use: Authorization: Bearer <api_key>',
			status: 401,
		};
	}

	// Validate API key format (prefix + alphanumeric chars)
	if (
		!apiKey.startsWith('lm_live_') ||
		apiKey.length < 40 ||
		!/^lm_live_[a-zA-Z0-9]+$/.test(apiKey)
	) {
		return {
			success: false,
			error: 'Invalid API key format',
			status: 401,
		};
	}

	// Hash the key for lookup
	const keyHash = await hashApiKey(apiKey);

	// Validate key and check rate limit in a single mutation
	// This ensures the rate limit is properly persisted in the database
	const result = await ctx.runMutation<
		| {
				success: true;
				keyId: Id<'apiKeys'>;
				scopes: string[];
		  }
		| {
				success: false;
				error: 'invalid_key';
		  }
		| {
				success: false;
				error: 'rate_limited';
				retryAfter: number;
		  }
	>(internal.auth.apiAuth.validateAndCheckRateLimit, { keyHash });

	if (!result.success) {
		if (result.error === 'invalid_key') {
			return {
				success: false,
				error: 'Invalid API key',
				status: 401,
			};
		}
		// Rate limited
		const now = Date.now();
		const resetTime = now + 1000; // 1 second window
		return {
			success: false,
			error: 'Rate limit exceeded. Maximum 10 requests per second.',
			status: 429,
			retryAfter: Math.ceil(result.retryAfter / 1000),
			rateLimit: {
				limit: RATE_LIMIT_MAX_REQUESTS,
				remaining: 0,
				reset: Math.ceil(resetTime / 1000),
			},
		};
	}

	// Update last used timestamp (fire and forget)
	ctx
		.runMutation(internal.auth.apiAuth.updateKeyLastUsed, { keyId: result.keyId })
		.catch((error) => {
			logError('[API Auth] Failed to update last used timestamp for key:', result.keyId, error);
		});

	const now = Date.now();
	const resetTime = now + 1000;
	return {
		success: true,
		keyId: result.keyId,
		scopes: result.scopes,
		rateLimit: {
			limit: RATE_LIMIT_MAX_REQUESTS,
			remaining: RATE_LIMIT_MAX_REQUESTS - 1, // Approximate
			reset: Math.ceil(resetTime / 1000),
		},
	};
}

// ============ INTERNAL QUERIES/MUTATIONS ============

/**
 * Internal mutation to validate API key and check rate limit
 * This combines both operations in a single transaction for efficiency
 * and ensures rate limits persist across Convex function invocations
 */
export const validateAndCheckRateLimit = internalMutation({
	args: {
		keyHash: v.string(),
	},
	handler: async (ctx, args) => {
		// First validate the key
		const key = await ctx.db
			.query('apiKeys')
			.withIndex('by_key_hash', (q) => q.eq('keyHash', args.keyHash))
			.first();

		if (!key || !isApiKeyUsable(key)) {
			return { success: false as const, error: 'invalid_key' as const };
		}

		// Check rate limit using the persistent rate limiter
		// Key is the API key ID to rate limit per-key
		const { ok, retryAfter } = await rateLimiter.limit(ctx, 'apiRequest', {
			key: key._id,
		});

		if (!ok) {
			return {
				success: false as const,
				error: 'rate_limited' as const,
				retryAfter: retryAfter ?? 1000,
			};
		}

		return {
			success: true as const,
			keyId: key._id,
			scopes: key.scopes ?? [],
		};
	},
});

/**
 * Internal mutation to update last used timestamp
 */
export const updateKeyLastUsed = internalMutation({
	args: {
		keyId: v.id('apiKeys'),
	},
	handler: async (ctx, args) => {
		const key = await ctx.db.get(args.keyId);
		if (!key) {
			return;
		}

		await ctx.db.patch(args.keyId, {
			lastUsedAt: Date.now(),
		});
	},
});

// ============ HTTP ACTION HANDLERS ============

/**
 * Handle CORS preflight requests
 */
export const handleCors = httpAction(async (_ctx, request) => {
	const origin = request.headers.get('Origin');
	return new Response(null, {
		status: 204,
		headers: {
			...sharedCorsHeaders(undefined, origin),
			'Access-Control-Max-Age': '86400',
		},
	});
});

/**
 * API health check endpoint
 */
export const healthCheck = httpAction(async () => {
	return jsonResponse({
		status: 'ok',
		timestamp: new Date().toISOString(),
	});
});

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

		// Call the handler with authenticated context
		try {
			const response = await handler(ctx as unknown as ActionContext, request, {
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
