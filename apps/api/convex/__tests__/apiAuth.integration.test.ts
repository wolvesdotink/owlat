import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import {
	extractApiKey,
	jsonResponse,
	errorResponse,
	authenticateApiRequest,
	isApiKeyUsable,
	requireScope,
	type AuthenticatedContext,
} from '../auth/apiAuth';
import { API_SCOPES, isApiScope, unknownScopes } from '../auth/apiScopes';

const modules = import.meta.glob('../**/*.*s');

// ============ Pure function tests ============

describe('extractApiKey', () => {
	it('returns null for missing Authorization header', () => {
		const request = new Request('https://example.com', {
			headers: {},
		});
		expect(extractApiKey(request)).toBeNull();
	});

	it('extracts token from Bearer header', () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: 'Bearer lm_live_abc123' },
		});
		expect(extractApiKey(request)).toBe('lm_live_abc123');
	});

	it('extracts raw token without Bearer prefix', () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: 'lm_live_abc123' },
		});
		expect(extractApiKey(request)).toBe('lm_live_abc123');
	});

	it('returns null for malformed header with multiple spaces', () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: 'Bearer token extra' },
		});
		expect(extractApiKey(request)).toBeNull();
	});

	it('handles case-insensitive Bearer prefix', () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: 'bearer lm_live_abc123' },
		});
		expect(extractApiKey(request)).toBe('lm_live_abc123');
	});
});

describe('jsonResponse', () => {
	it('returns response with correct status code', async () => {
		const response = jsonResponse({ ok: true }, 200);
		expect(response.status).toBe(200);

		const body = await response.json();
		expect(body).toEqual({ ok: true });
	});

	it('sets Content-Type and CORS headers', () => {
		const response = jsonResponse({});
		expect(response.headers.get('Content-Type')).toBe('application/json');
		// Default origin is ALLOWED_ORIGINS[0] (http://localhost:3000)
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
		expect(response.headers.get('Vary')).toBe('Origin');
		expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
			'Content-Type, Authorization'
		);
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
			'GET, POST, PUT, DELETE, OPTIONS'
		);
	});

	it('includes rate limit headers when provided', () => {
		const rateLimit = { limit: 10, remaining: 9, reset: 1700000 };
		const response = jsonResponse({}, 200, {}, rateLimit);
		expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
		expect(response.headers.get('X-RateLimit-Remaining')).toBe('9');
		expect(response.headers.get('X-RateLimit-Reset')).toBe('1700000');
	});

	it('does not include rate limit headers when not provided', () => {
		const response = jsonResponse({});
		expect(response.headers.get('X-RateLimit-Limit')).toBeNull();
	});

	it('merges custom headers', () => {
		const response = jsonResponse({}, 200, { 'X-Custom': 'value' });
		expect(response.headers.get('X-Custom')).toBe('value');
	});

	it('uses 200 as default status', () => {
		const response = jsonResponse({});
		expect(response.status).toBe(200);
	});
});

describe('errorResponse', () => {
	it('returns the Operation error envelope with the category', async () => {
		const response = errorResponse('internal', 'Something went wrong');
		const body = await response.json();

		expect(response.status).toBe(500);
		expect(body).toEqual({
			error: {
				category: 'internal',
				message: 'Something went wrong',
			},
		});
	});

	it('derives the HTTP status from the category', () => {
		expect(errorResponse('invalid_input', 'x').status).toBe(400);
		expect(errorResponse('unauthenticated', 'x').status).toBe(401);
		expect(errorResponse('forbidden', 'x').status).toBe(403);
		expect(errorResponse('not_found', 'x').status).toBe(404);
		expect(errorResponse('rate_limited', 'x').status).toBe(429);
		expect(errorResponse('internal', 'x').status).toBe(500);
	});

	it('carries data through to the body', async () => {
		const response = errorResponse('invalid_input', 'Bad field', { data: { field: 'email' } });
		const body = await response.json();
		expect(body.error.data).toEqual({ field: 'email' });
	});

	it('sets Retry-After header when provided', () => {
		const response = errorResponse('rate_limited', 'Rate limited', { retryAfter: 30 });
		expect(response.headers.get('Retry-After')).toBe('30');
	});

	it('does not set Retry-After header when not provided', () => {
		const response = errorResponse('internal', 'Error');
		expect(response.headers.get('Retry-After')).toBeNull();
	});

	it('includes rate limit headers', () => {
		const rateLimit = { limit: 10, remaining: 0, reset: 1700000 };
		const response = errorResponse('rate_limited', 'Rate limited', { retryAfter: 1, rateLimit });
		expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
		expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
	});
});

describe('isApiKeyUsable', () => {
	const now = 1_000_000;

	it('accepts an active key with no expiry', () => {
		expect(isApiKeyUsable({ isActive: true }, now)).toBe(true);
	});

	it('accepts an active key whose expiry is still in the future', () => {
		expect(isApiKeyUsable({ isActive: true, expiresAt: now + 1 }, now)).toBe(true);
	});

	it('rejects an active key whose expiry has passed', () => {
		expect(isApiKeyUsable({ isActive: true, expiresAt: now - 1 }, now)).toBe(false);
	});

	it('rejects an active key expiring exactly now (boundary is inclusive)', () => {
		expect(isApiKeyUsable({ isActive: true, expiresAt: now }, now)).toBe(false);
	});

	it('rejects an inactive key even with a future expiry', () => {
		expect(isApiKeyUsable({ isActive: false, expiresAt: now + 10_000 }, now)).toBe(false);
	});
});

// ============ Integration tests with Convex DB ============

describe('expiry enforcement (stored key round-trip)', () => {
	it('rejects a stored active-but-expired key and accepts an unexpired one', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const now = Date.now();
			const expiredId = await ctx.db.insert('apiKeys', {
				name: 'Expired',
				keyHash: 'hash_expired',
				keyPrefix: 'lm_live_',
				isActive: true,
				expiresAt: now - 1000,
				createdAt: now,
				updatedAt: now,
			});
			const liveId = await ctx.db.insert('apiKeys', {
				name: 'Live',
				keyHash: 'hash_live',
				keyPrefix: 'lm_live_',
				isActive: true,
				expiresAt: now + 60_000,
				createdAt: now,
				updatedAt: now,
			});

			const expired = await ctx.db.get(expiredId);
			const live = await ctx.db.get(liveId);
			expect(isApiKeyUsable(expired!, now)).toBe(false);
			expect(isApiKeyUsable(live!, now)).toBe(true);
		});
	});
});

describe('validateApiKey (handler logic)', () => {
	it('returns null for non-existent key hash', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const key = await ctx.db
				.query('apiKeys')
				.withIndex('by_key_hash', (q) => q.eq('keyHash', 'nonexistent'))
				.first();

			expect(key).toBeNull();
		});
	});

	it('returns null for inactive key', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('apiKeys', {
				name: 'Test Key',
				keyHash: 'hash123',
				keyPrefix: 'lm_live_',
				isActive: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const key = await ctx.db
				.query('apiKeys')
				.withIndex('by_key_hash', (q) => q.eq('keyHash', 'hash123'))
				.first();

			// Replicate the validateApiKey handler logic
			const result = key && key.isActive ? { keyId: key._id } : null;
			expect(result).toBeNull();
		});
	});

	it('returns keyId for valid active key', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			const keyId = await ctx.db.insert('apiKeys', {
				name: 'Test Key',
				keyHash: 'hash123',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const key = await ctx.db
				.query('apiKeys')
				.withIndex('by_key_hash', (q) => q.eq('keyHash', 'hash123'))
				.first();

			const result = key && key.isActive ? { keyId: key._id } : null;
			expect(result).not.toBeNull();
			expect(result!.keyId).toBe(keyId);
		});
	});

	it('distinguishes between keys by hash', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('apiKeys', {
				name: 'Key 1',
				keyHash: 'hash_aaa',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'Key 2',
				keyHash: 'hash_bbb',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const key1 = await ctx.db
				.query('apiKeys')
				.withIndex('by_key_hash', (q) => q.eq('keyHash', 'hash_aaa'))
				.first();
			const key2 = await ctx.db
				.query('apiKeys')
				.withIndex('by_key_hash', (q) => q.eq('keyHash', 'hash_bbb'))
				.first();

			expect(key1?.name).toBe('Key 1');
			expect(key2?.name).toBe('Key 2');
		});
	});
});

describe('authenticateApiRequest', () => {
	it('returns error for missing Authorization header', async () => {
		const request = new Request('https://example.com');
		const mockCtx = {
			runQuery: vi.fn(),
			runMutation: vi.fn(),
		};

		const result = await authenticateApiRequest(mockCtx, request);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.status).toBe(401);
			expect(result.error).toContain('Missing or invalid Authorization header');
		}
	});

	it('returns error for invalid API key format (no prefix)', async () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: 'Bearer invalid_key_format_abc' },
		});
		const mockCtx = {
			runQuery: vi.fn(),
			runMutation: vi.fn(),
		};

		const result = await authenticateApiRequest(mockCtx, request);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.status).toBe(401);
			expect(result.error).toContain('Invalid API key format');
		}
	});

	it('returns error for API key that is too short', async () => {
		const request = new Request('https://example.com', {
			headers: { Authorization: 'Bearer lm_live_short' },
		});
		const mockCtx = {
			runQuery: vi.fn(),
			runMutation: vi.fn(),
		};

		const result = await authenticateApiRequest(mockCtx, request);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.status).toBe(401);
			expect(result.error).toContain('Invalid API key format');
		}
	});

	it('returns error when key is invalid', async () => {
		const validKey = 'lm_live_' + 'a'.repeat(40);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Bearer ${validKey}` },
		});

		const mockCtx = {
			runQuery: vi.fn(),
			runMutation: vi.fn().mockResolvedValue({
				success: false,
				error: 'invalid_key',
			}),
		};

		const result = await authenticateApiRequest(mockCtx, request);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.status).toBe(401);
			expect(result.error).toBe('Invalid API key');
		}
	});

	it('returns rate limit error when rate limited', async () => {
		const validKey = 'lm_live_' + 'a'.repeat(40);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Bearer ${validKey}` },
		});

		const mockCtx = {
			runQuery: vi.fn(),
			runMutation: vi.fn().mockResolvedValue({
				success: false,
				error: 'rate_limited',
				retryAfter: 500,
			}),
		};

		const result = await authenticateApiRequest(mockCtx, request);
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.status).toBe(429);
			expect(result.retryAfter).toBe(1);
			expect(result.rateLimit).toBeDefined();
			expect(result.rateLimit!.remaining).toBe(0);
		}
	});

	it('returns success with keyId and rateLimit for valid key', async () => {
		const validKey = 'lm_live_' + 'a'.repeat(40);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Bearer ${validKey}` },
		});

		const mockCtx = {
			runQuery: vi.fn(),
			runMutation: vi
				.fn()
				.mockResolvedValueOnce({
					success: true,
					keyId: 'key123',
				})
				// updateKeyLastUsed call (fire and forget)
				.mockResolvedValueOnce(undefined),
		};

		const result = await authenticateApiRequest(mockCtx, request);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.keyId).toBe('key123');
			expect(result.rateLimit).toBeDefined();
			expect(result.rateLimit.limit).toBe(10);
		}
	});

	it('calls runMutation to validate key and check rate limit', async () => {
		const validKey = 'lm_live_' + 'a'.repeat(40);
		const request = new Request('https://example.com', {
			headers: { Authorization: `Bearer ${validKey}` },
		});

		const mockCtx = {
			runQuery: vi.fn(),
			runMutation: vi
				.fn()
				.mockResolvedValueOnce({
					success: true,
					keyId: 'key123',
				})
				.mockResolvedValueOnce(undefined),
		};

		await authenticateApiRequest(mockCtx, request);

		// First call should be validateAndCheckRateLimit
		expect(mockCtx.runMutation).toHaveBeenCalledTimes(2);
	});
});

// ============ Scope enforcement ============

describe('requireScope', () => {
	const rateLimit = { limit: 10, remaining: 9, reset: 0 };
	function authWith(scopes: string[]): AuthenticatedContext {
		return { keyId: 'k' as AuthenticatedContext['keyId'], scopes, rateLimit };
	}

	it('permits a call when the key carries the scope (returns null)', () => {
		expect(requireScope(authWith(['contacts:read']), 'contacts:read')).toBeNull();
	});

	it('forbids (403) when the key lacks the scope', () => {
		const denied = requireScope(authWith(['contacts:read']), 'contacts:write');
		expect(denied).not.toBeNull();
		expect(denied!.status).toBe(403);
	});

	it('forbids when the key has no scopes at all', () => {
		const denied = requireScope(authWith([]), 'events:write');
		expect(denied?.status).toBe(403);
	});
});

describe('apiScopes vocabulary', () => {
	it('recognises every known scope and rejects unknowns', () => {
		for (const scope of API_SCOPES) expect(isApiScope(scope)).toBe(true);
		expect(isApiScope('contacts:delete')).toBe(false);
		expect(unknownScopes(['contacts:read', 'bogus:scope'])).toEqual(['bogus:scope']);
		expect(unknownScopes([...API_SCOPES])).toEqual([]);
	});
});
