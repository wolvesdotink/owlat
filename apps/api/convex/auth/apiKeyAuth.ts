/**
 * API-key verification: the credential half of the key-authed v1 surface.
 *
 * Split out of `auth/apiAuth.ts` (file-size ratchet). Hashing, usability and
 * format rules plus `authenticateApiRequest`, which drives them against the
 * `auth/apiAuth.ts` internal mutations (key lookup + rate limit in one
 * transaction, then the fire-and-forget last-used touch).
 */
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { getClientIp } from '../publicRateLimit';
import { logError } from '../lib/runtimeLog';
import type { RateLimitHeaders } from './apiResponses';

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

export interface AuthContext {
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
	// This ensures the rate limit is properly persisted in the database.
	// The client IP meters FAILED lookups (see below) so a wrong-key flood can't
	// probe the key store unbounded — a valid key never spends that bucket.
	const clientIp = getClientIp(request);
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
	>(internal.auth.apiAuth.validateAndCheckRateLimit, { keyHash, ip: clientIp });

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
