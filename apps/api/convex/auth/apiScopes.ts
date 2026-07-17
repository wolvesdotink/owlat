/**
 * API-key scopes — the permission vocabulary for the public v1 HTTP API and
 * (Tier 2) for plugin-bound connected-app keys.
 *
 * Each scope gates one resource × action. A key carries a subset of these in
 * its `scopes` column; the v1 handlers call `requireScope` to enforce them.
 * Key creation requires an explicit, non-empty scope list (see
 * `auth/apiKeys.ts:create`) — keys are least-privilege by construction, not
 * all-access by default. Legacy rows with an absent `scopes` field are deny-all
 * at enforcement (`key.scopes ?? []`).
 *
 * The scope string doubles as the plugin-capability string for API access: a
 * key bound to a plugin (`apiKeys.pluginId`) may only carry a scope the plugin
 * *declared* in its manifest capabilities AND the operator *granted*. Grants
 * can only restrict the manifest, never widen it, and the effective scope set
 * is re-derived on every request so disabling the plugin or revoking the grant
 * takes effect immediately (see `plugins/apiKeyBinding.ts`).
 *
 * The first block is one scope per real v1 endpoint. The second block is the
 * expanded Tier-2 vocabulary from the plugin-platform roadmap (break 06): the
 * capability surface connected apps request via plugin-bound keys. `contacts:*`
 * and `topics:write` also serve as connected-app capabilities.
 */

export const API_SCOPES = [
	// v1 HTTP endpoints
	'contacts:read',
	'contacts:write',
	'events:write',
	'transactional:send',
	'topics:write',
	// Tier-2 connected-app capability vocabulary (plugin-bound keys)
	'campaigns:read',
	'mail:read',
	'knowledge:read',
	'webhooks:manage',
	'plugin-storage:read',
	'plugin-storage:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

/** True iff `value` is a known API scope. */
export function isApiScope(value: string): value is ApiScope {
	return API_SCOPE_SET.has(value);
}

/**
 * Validate a requested scope list against the vocabulary. Returns the unknown
 * scopes (empty array ⇒ all valid). Used at key-creation time to reject typos.
 */
export function unknownScopes(scopes: readonly string[]): string[] {
	return scopes.filter((s) => !isApiScope(s));
}
