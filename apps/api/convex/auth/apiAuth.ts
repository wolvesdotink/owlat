/**
 * The Convex functions behind API-key authentication.
 *
 * The plain helpers this module used to also carry live in three siblings, all
 * addressed by direct import (they are not Convex functions):
 *
 *   - `auth/apiResponses.ts` — the key-authed JSON/error/405 envelopes;
 *   - `auth/apiKeyAuth.ts`   — hashing, usability, format, `authenticateApiRequest`;
 *   - `auth/apiHandlers.ts`  — the body cap, `requireScope`, and
 *     `createAuthenticatedHandler`.
 *
 * What stays here is what has a generated path (`internal.auth.apiAuth.*`) or is
 * registered as a route in `http.ts`.
 */
import { httpAction, internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import { rateLimiter } from '../rateLimiter';
import { corsHeaders as sharedCorsHeaders } from '../lib/cors';
import { deriveEffectiveScopes } from '../plugins/apiKeyBinding';
import { isApiKeyUsable } from './apiKeyAuth';
import { jsonResponse } from './apiResponses';

// ============ INTERNAL QUERIES/MUTATIONS ============

/**
 * Internal mutation to validate API key and check rate limit
 * This combines both operations in a single transaction for efficiency
 * and ensures rate limits persist across Convex function invocations
 */
export const validateAndCheckRateLimit = internalMutation({
	args: {
		keyHash: v.string(),
		// Client IP (resolved by `getClientIp`, honoring RATE_LIMIT_TRUSTED_PROXY).
		// Optional so a legacy caller still type-checks; absent ⇒ the shared
		// 'unknown' bucket, exactly like every other public per-IP limiter.
		ip: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		// First validate the key
		const key = await ctx.db
			.query('apiKeys')
			.withIndex('by_key_hash', (q) => q.eq('keyHash', args.keyHash))
			.first();

		if (!key || !isApiKeyUsable(key)) {
			// Meter the FAILURE per IP. A wrong/expired/unknown key never reaches
			// the per-key `apiRequest` bucket, so this coarse throttle is the only
			// thing bounding a brute-force sweep over key hashes. Exhausting it
			// returns `rate_limited` (429) instead of `invalid_key` (401) — a valid
			// key is unaffected because a successful lookup never spends this token.
			const failure = await rateLimiter.limit(ctx, 'apiKeyAuthFailure', {
				key: args.ip ?? 'unknown',
			});
			if (!failure.ok) {
				return {
					success: false as const,
					error: 'rate_limited' as const,
					retryAfter: failure.retryAfter ?? 1000,
				};
			}
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

		// Effective scopes are re-derived every request. A standalone key returns
		// its stored scopes; a plugin-bound key is re-checked against the live
		// manifest, feature flag, and operator grants, so disabling or
		// uninstalling the plugin, or revoking a grant, fails the key closed
		// immediately without touching the key row.
		const scopes = await deriveEffectiveScopes(ctx, key);

		return {
			success: true as const,
			keyId: key._id,
			scopes,
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
