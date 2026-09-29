/**
 * Compile-time equality checks for a parser's own type and the Convex
 * validator it feeds.
 *
 * Mutual assignability is not enough for these: `{ a: string }` and
 * `{ a: string; b?: number }` are assignable both ways, so a validator that
 * gains an optional field, or a parser that starts emitting one, would pass.
 * `Exact` compares the two types member by member instead, after flattening
 * intersections and Convex's mapped `Infer` output into plain object types.
 *
 * Use it as `export type _Guard = AssertTrue<Exact<A, B>>`: the alias only
 * resolves when the two agree, so drift is a build error.
 */

type Flatten<T> = T extends readonly (infer E)[]
	? Flatten<E>[]
	: T extends object
		? { [K in keyof T]: Flatten<T[K]> }
		: T;

type Identical<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** `true` when `A` and `B` have exactly the same members, else `false`. */
export type Exact<A, B> = Identical<Flatten<A>, Flatten<B>>;

/** Resolves only when its argument is `true`; otherwise it is a build error. */
export type AssertTrue<T extends true> = T;
