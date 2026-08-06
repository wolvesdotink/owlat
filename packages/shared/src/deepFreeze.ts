/**
 * Freeze a data literal THROUGH — the object, its arrays and everything they
 * hold — so that "single source of truth" is a RUNTIME property and not just a
 * `readonly` the checker enforces for callers who kept their types.
 *
 * A LEAF UTILITY OF ITS OWN because it is not about providers: it was extracted
 * from `./sendProviderCatalog` when a second module wanted the same guarantee,
 * and any module that calls itself a single source of truth and ships to the
 * browser bundle wants it.
 *
 * `Object.freeze` alone is shallow: it would leave every entry object, every
 * `requiredEnvVars` / `credentialFields` array and the attached preset table
 * writable, and the catalog ships to the browser bundle, where a consumer
 * reaching it through untyped JS or a cast could rewrite what every later reader
 * sees. Terminates because the catalog is a finite tree of literals with no
 * cycles; already-frozen members (the preset table freezes itself at its
 * declaration) are re-frozen harmlessly.
 */
export function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	Object.freeze(value);
	for (const member of Object.values(value)) deepFreeze(member);
	return value;
}
