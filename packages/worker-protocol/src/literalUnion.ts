import { v, type VLiteral, type VUnion } from 'convex/values';

/**
 * Builds a closed Convex union from a literal list, so a validator whose
 * vocabulary already exists as a tuple is derived from it and cannot drift
 * from the tuple's exported type. It mirrors apps/api's `lib/literalUnion.ts`;
 * this package cannot import from apps/api, so it keeps its own leaf copy
 * (it imports only `convex/values`).
 *
 * An `as const` tuple infers `T[number]`, the same closed union a hand-written
 * `v.union(v.literal(...))` gives. A computed list takes the second overload,
 * and an empty list throws at module load instead of building a validator
 * that accepts nothing.
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
