/**
 * API-key scopes — the permission vocabulary for the public v1 HTTP API.
 *
 * Each scope gates one resource × action. A key carries a subset of these in
 * its `scopes` column; the v1 handlers call `requireScope` to enforce them.
 * Key creation requires an explicit, non-empty scope list (see
 * `auth/apiKeys.ts:create`) — keys are least-privilege by construction, not
 * all-access by default. Legacy rows with an absent `scopes` field are deny-all
 * at enforcement (`key.scopes ?? []`).
 *
 * This is intentionally small — one scope per real v1 endpoint, no speculative
 * scopes. Add a scope only when a new key-authed endpoint needs one.
 */

export const API_SCOPES = [
	'contacts:read',
	'contacts:write',
	'events:write',
	'transactional:send',
	'topics:write',
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
