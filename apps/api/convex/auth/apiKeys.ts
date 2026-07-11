import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { API_SCOPES, unknownScopes } from './apiScopes';
import { hashApiKey } from './apiAuth';
import { randomToken } from '../lib/randomToken';

// ============ QUERIES ============

/**
 * List all API keys for an organization (active and revoked)
 */
export const listByTeam = authedQuery({
	args: {
		includeRevoked: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can view API keys'
		);
		const { includeRevoked = false } = args;

		let keys = await ctx.db.query('apiKeys').collect(); // bounded: per-org API keys (few)

		if (!includeRevoked) {
			keys = keys.filter((k) => k.isActive);
		}

		// Sort by creation date descending (newest first)
		return keys.sort((a, b) => b.createdAt - a.createdAt);
	},
});

/**
 * Get a single API key by ID
 */
export const get = authedQuery({
	args: {
		keyId: v.id('apiKeys'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can view API keys'
		);
		return await ctx.db.get(args.keyId);
	},
});

/**
 * Count API keys for an organization
 */
export const countByTeam = authedQuery({
	args: {},
	handler: async (ctx) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can view API keys'
		);
		const allKeys = await ctx.db.query('apiKeys').collect(); // bounded: per-org API keys (few)
		const activeKeys = allKeys.filter((k) => k.isActive);

		return {
			active: activeKeys.length,
		};
	},
});

// ============ MUTATIONS ============

/**
 * Create a new API key
 * Returns the full key only once - it's not stored
 */
export const create = authedMutation({
	args: {
		name: v.string(),
		scopes: v.optional(v.array(v.string())),
		// Optional hard expiry (epoch ms). Must be in the future when provided;
		// past that instant the key is rejected at verification.
		expiresAt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can create API keys'
		);
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');

		const { name, scopes, expiresAt } = args;

		// A supplied expiry must be in the future — a past (or now) expiry would
		// mint a key that is dead on arrival.
		if (expiresAt !== undefined && expiresAt <= Date.now()) {
			throwInvalidInput('API key expiry must be in the future');
		}

		// Validate name
		if (!name.trim()) {
			throwInvalidInput('API key name is required');
		}

		// Least-privilege by construction: a new key carries EXACTLY the scopes the
		// operator selected. Omitting scopes no longer silently grants all of them
		// (the old default), which made every dashboard-minted key a full-access
		// key. An explicit, non-empty list is required and validated against the
		// vocabulary (reject typos). (Legacy rows with an absent `scopes` field are
		// already deny-all at enforcement via `key.scopes ?? []`.)
		if (!scopes || scopes.length === 0) {
			throwInvalidInput(
				`At least one API scope is required. Valid scopes: ${API_SCOPES.join(', ')}`
			);
		}
		const bad = unknownScopes(scopes);
		if (bad.length > 0) {
			throwInvalidInput(
				`Unknown API scope(s): ${bad.join(', ')}. Valid scopes: ${API_SCOPES.join(', ')}`
			);
		}
		// De-dupe while preserving order.
		const resolvedScopes: string[] = [...new Set(scopes)];

		// Generate the API key (format: lm_live_<32 random alphanumeric chars>)
		const apiKey = randomToken(32, 'lm_live_');

		// Hash the key for storage
		const keyHash = await hashApiKey(apiKey);

		// Extract prefix for display (e.g., "lm_live_abc12345")
		const keyPrefix = apiKey.substring(0, 16);

		const now = Date.now();

		// Create the API key record
		const keyId = await ctx.db.insert('apiKeys', {
			name: name.trim(),
			keyHash,
			keyPrefix,
			scopes: resolvedScopes,
			isActive: true,
			...(expiresAt !== undefined ? { expiresAt } : {}),
			createdAt: now,
			updatedAt: now,
		});

		// Return the full key - this is the only time it will be shown
		return {
			keyId,
			apiKey, // Full key shown only once
			keyPrefix,
			name: name.trim(),
		};
	},
});

/**
 * Update API key name
 */
export const updateName = authedMutation({
	args: {
		keyId: v.id('apiKeys'),
		name: v.string(),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can manage API keys'
		);
		const { keyId, name } = args;

		await getOrThrow(ctx, keyId, 'API key');

		if (!name.trim()) {
			throwInvalidInput('API key name is required');
		}

		await ctx.db.patch(keyId, {
			name: name.trim(),
			updatedAt: Date.now(),
		});

		return { success: true };
	},
});

/**
 * Revoke an API key (soft delete)
 */
export const revoke = authedMutation({
	args: {
		keyId: v.id('apiKeys'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can revoke API keys'
		);
		const key = await getOrThrow(ctx, args.keyId, 'API key');

		if (!key.isActive) {
			throwInvalidState('API key is already revoked');
		}

		const now = Date.now();

		await ctx.db.patch(args.keyId, {
			isActive: false,
			revokedAt: now,
			updatedAt: now,
		});

		return { success: true };
	},
});

/**
 * Delete an API key permanently
 */
export const remove = authedMutation({
	args: {
		keyId: v.id('apiKeys'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can delete API keys'
		);
		await getOrThrow(ctx, args.keyId, 'API key');

		await ctx.db.delete(args.keyId);

		return { success: true };
	},
});
