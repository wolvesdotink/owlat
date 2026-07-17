import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { API_SCOPES, unknownScopes, tier2OnlyScopes } from './apiScopes';
import { hashApiKey } from './apiAuth';
import { randomToken } from '../lib/randomToken';
import { parsePluginId } from '@owlat/plugin-kit';
import { allowedPluginBoundScopes, loadPluginBoundKeyContext } from '../plugins/apiKeyBinding';

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
		// Tier-2 binding. When set, this key belongs to the named bundled plugin /
		// connected app: its requested scopes must be a subset of the plugin's
		// operator-granted, manifest-declared capabilities (grants can only
		// restrict the manifest), and it can be revoked in one shot by pluginId.
		pluginId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can create API keys'
		);
		// Validate input lengths
		validateStringLength(args.name, STRING_LIMITS.NAME, 'Name');

		const { name, scopes, expiresAt, pluginId: pluginIdInput } = args;

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

		// Tier-2 plugin binding: the manifest is the ceiling, the operator grant
		// restricts it. A bound key may only carry scopes the plugin *declared*
		// AND the operator *granted*. This is enforced again on every request
		// (deriveEffectiveScopes), but rejecting at creation gives an immediate,
		// legible error instead of minting a key that silently authorizes nothing.
		let boundPluginId: string | undefined;
		if (pluginIdInput === undefined) {
			// Standalone (operator-managed) key. The Tier-2-only vocabulary is the
			// connected-app surface reachable ONLY through a plugin-bound key
			// (manifest ceiling + operator grant); it has no standalone meaning.
			// Reject it at mint so the plugin-binding boundary cannot be bypassed by
			// minting an unbound key that carries a connected-app-only scope — the
			// boundary is enforced here, not left to UI convention.
			const tier2 = tier2OnlyScopes(resolvedScopes);
			if (tier2.length > 0) {
				throwInvalidInput(
					`Scope(s) ${tier2.join(', ')} are only available on plugin-bound keys; ` +
						'supply a pluginId to use them.'
				);
			}
		} else {
			try {
				boundPluginId = parsePluginId(pluginIdInput);
			} catch {
				throwInvalidInput('Invalid pluginId');
			}
			const context = await loadPluginBoundKeyContext(ctx, pluginIdInput);
			if (context.manifest === null || !context.flagEnabled) {
				throwInvalidState('Cannot bind an API key to a plugin that is not installed and enabled');
			}
			const allowed = new Set<string>(allowedPluginBoundScopes(context));
			const disallowed = resolvedScopes.filter((s) => !allowed.has(s));
			if (disallowed.length > 0) {
				throwInvalidInput(
					`Plugin-bound key requests scope(s) the plugin has not been granted: ${disallowed.join(', ')}. ` +
						`Grantable scopes: ${[...allowed].join(', ') || '(none)'}`
				);
			}
		}

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
			...(boundPluginId !== undefined ? { pluginId: boundPluginId } : {}),
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
 * Revoke every active API key bound to a plugin in one shot (Tier-2 "one-click
 * revocation"). Used when an operator disconnects a connected app: all of that
 * app's keys stop authenticating immediately. Idempotent — returns the number
 * of keys revoked, zero when the plugin has no active keys.
 */
export const revokeByPlugin = authedMutation({
	args: {
		pluginId: v.string(),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can revoke API keys'
		);

		// Reject an unparseable id rather than scanning for a literal that can
		// never have been stored.
		try {
			parsePluginId(args.pluginId);
		} catch {
			throwInvalidInput('Invalid pluginId');
		}

		const keys = await ctx.db
			.query('apiKeys')
			.withIndex('by_plugin_id', (q) => q.eq('pluginId', args.pluginId))
			.collect(); // bounded: keys for one plugin (few)

		const now = Date.now();
		let revoked = 0;
		for (const key of keys) {
			if (!key.isActive) continue;
			await ctx.db.patch(key._id, { isActive: false, revokedAt: now, updatedAt: now });
			revoked += 1;
		}

		return { revoked };
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
