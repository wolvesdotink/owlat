import { v, type VLiteral, type VUnion } from 'convex/values';

/**
 * The one way to build a closed Convex union from a list of literals, so a
 * vocabulary owned by a catalog or by `@owlat/shared` is never re-spelled as
 * `v.union(v.literal(...), ...)`. The hand-rolled `v.union(...X.map((x) =>
 * v.literal(x)))` form is banned by `scripts/check-convex-patterns.sh`.
 *
 * A leaf module (it imports only `convex/values`), so catalogs that
 * `convexValidators.ts` itself re-exports, and the schema, can use it without
 * an import cycle.
 *
 * - An `as const` tuple (strings or numbers) infers `T[number]`, the same closed
 *   union a hand-written `v.union(v.literal(...))` gives.
 * - A computed list (a `.filter` subset, a plugin-composed catalog, a `Set`)
 *   is not a tuple type, so it takes the second overload: the union is its
 *   element type, and an empty list throws at module load instead of building
 *   a validator that accepts nothing.
 *
 * `.members` stays available for parity tests either way.
 */
export function literalUnion<const T extends readonly [Literal, ...Literal[]]>(
	values: T
): VUnion<T[number], VLiteral<T[number]>[]>;
export function literalUnion<T extends Literal>(values: Iterable<T>): VUnion<T, VLiteral<T>[]>;
export function literalUnion(values: Iterable<Literal>) {
	const [first, ...rest] = values;
	if (first === undefined) throw new Error('literalUnion needs at least one literal');
	return v.union(v.literal(first), ...rest.map((value) => v.literal(value)));
}

type Literal = string | number;
