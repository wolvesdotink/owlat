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
 * The vocabulary is partitioned in two:
 *
 * - `ENDPOINT_SCOPES` — one scope per real v1 HTTP endpoint. These are the only
 *   scopes a standalone (operator-managed, unbound) key may carry. `contacts:*`
 *   and `topics:write` also serve as connected-app capabilities.
 * - `TIER2_ONLY_SCOPES` — the expanded Tier-2 vocabulary from the plugin-platform
 *   roadmap (break 06): the capability surface connected apps request *only* via
 *   plugin-bound keys. These have no standalone-key meaning; a key must be bound
 *   to a plugin (manifest ceiling + operator grant) to carry any of them, so
 *   `create` rejects them on an unbound key (fail closed at mint).
 */

/** Scopes backed by a real v1 HTTP endpoint; usable on standalone keys. */
export const ENDPOINT_SCOPES = [
	'contacts:read',
	'contacts:write',
	'events:write',
	'transactional:send',
	'topics:write',
] as const;

/**
 * Connected-app capability vocabulary reachable ONLY through a plugin-bound key.
 * Never valid on a standalone key.
 */
export const TIER2_ONLY_SCOPES = [
	'campaigns:read',
	'mail:read',
	'knowledge:read',
	'webhooks:manage',
	'plugin-storage:read',
	'plugin-storage:write',
] as const;

export const API_SCOPES = [...ENDPOINT_SCOPES, ...TIER2_ONLY_SCOPES] as const;

export type ApiScope = (typeof API_SCOPES)[number];

const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);
const TIER2_ONLY_SCOPE_SET: ReadonlySet<string> = new Set(TIER2_ONLY_SCOPES);

/** True iff `value` is a known API scope. */
export function isApiScope(value: string): value is ApiScope {
	return API_SCOPE_SET.has(value);
}

/**
 * True iff `value` is a Tier-2-only scope — one that has no standalone-key
 * meaning and may appear only on a plugin-bound key.
 */
export function isTier2OnlyScope(value: string): value is (typeof TIER2_ONLY_SCOPES)[number] {
	return TIER2_ONLY_SCOPE_SET.has(value);
}

/**
 * Filter a requested scope list down to the Tier-2-only scopes it contains.
 * Used at creation time to reject connected-app scopes on an unbound key.
 */
export function tier2OnlyScopes(scopes: readonly string[]): string[] {
	return scopes.filter(isTier2OnlyScope);
}

/**
 * Validate a requested scope list against the vocabulary. Returns the unknown
 * scopes (empty array ⇒ all valid). Used at key-creation time to reject typos.
 */
export function unknownScopes(scopes: readonly string[]): string[] {
	return scopes.filter((s) => !isApiScope(s));
}
