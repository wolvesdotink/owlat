/**
 * Freeze a data literal THROUGH — the object, its arrays and everything they
 * hold.
 *
 * A leaf utility of its own because it is not about providers: any module that
 * calls itself a single source of truth and ships to the browser bundle wants
 * "single source of truth" to be a RUNTIME property, not just a `readonly` the
 * checker enforces for callers who kept their types.
 */
/**
 * Freeze a data literal THROUGH — the object, its arrays and everything they
 * hold — so that "single source of truth" is a runtime property and not just a
 * `readonly` the checker enforces for callers who kept their types.
 *
 * `Object.freeze` alone is shallow: it would leave every entry object, every
 * `requiredEnvVars` / `credentialFields` array and the attached preset table
 * writable, and this module ships to the browser bundle, where a consumer
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
