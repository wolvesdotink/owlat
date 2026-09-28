import { v, type VLiteral, type VUnion } from 'convex/values';

/**
 * A closed string union derived from an `as const` array, so a vocabulary owned
 * by `@owlat/shared` is never re-spelled here. The inferred type is
 * `T[number]`, the same closed union a hand-written `v.union(v.literal(...))`
 * gives, and `.members` stays available for parity tests. The cast is needed
 * because destructuring a generic tuple widens the rest to `string[]`.
 *
 * A leaf (imports only `convex/values`) so `literalValidators.ts` and
 * `appLocales.ts` can use it without a cycle through `convexValidators.ts`,
 * which re-exports it for existing importers.
 */
export function literalUnion<const T extends readonly [string, ...string[]]>(values: T) {
	const [first, ...rest] = values;
	return v.union(v.literal(first), ...rest.map((value) => v.literal(value))) as VUnion<
		T[number],
		VLiteral<T[number]>[]
	>;
}
