import { v, type PropertyValidators, type VOptional } from 'convex/values';

// Helpers for reusing a table's field record as function arguments.
//
// A schema file exports the record it hands to `defineTable` (`export const
// fooFields = {...}; defineTable(fooFields)`), and the functions that write
// the table derive their `args` from it instead of retyping every field:
//
//   args: omit(fooFields, ['createdAt', 'updatedAt'])
//   args: optionalFields(pick(fooFields, ['title', 'tags']))
//
// A field added to or narrowed in the table then reaches its writers in the
// same edit. The helpers return the same validator instances, so the derived
// args are value-for-value the fields they name.

type FieldKey<F> = keyof F & string;

/** Optional form of a field record: each required validator is wrapped in `v.optional`. */
export type OptionalFields<F extends PropertyValidators> = {
	[K in keyof F]: F[K]['isOptional'] extends 'optional' ? F[K] : VOptional<F[K]>;
};

/** The named fields of a record, in the order given. */
export function pick<F extends PropertyValidators, const K extends readonly FieldKey<F>[]>(
	fields: F,
	keys: K
): Pick<F, K[number]> {
	const picked: PropertyValidators = {};
	for (const key of keys) {
		const validator = fields[key];
		if (validator === undefined) throw new Error(`pick: unknown field "${key}"`);
		picked[key] = validator;
	}
	return picked as Pick<F, K[number]>;
}

/** Every field of a record except the named ones, in the record's order. */
export function omit<F extends PropertyValidators, const K extends readonly FieldKey<F>[]>(
	fields: F,
	keys: K
): Omit<F, K[number]> {
	const dropped = new Set<string>(keys);
	for (const key of dropped) {
		if (!(key in fields)) throw new Error(`omit: unknown field "${key}"`);
	}
	const kept = Object.entries(fields).filter(([key]) => !dropped.has(key));
	return Object.fromEntries(kept) as Omit<F, K[number]>;
}

/**
 * The record with every field optional, for patch-style arguments. A field
 * that is already optional keeps its validator instance.
 */
export function optionalFields<F extends PropertyValidators>(fields: F): OptionalFields<F> {
	return Object.fromEntries(
		Object.entries(fields).map(([key, validator]) => [
			key,
			validator.isOptional === 'optional' ? validator : v.optional(validator),
		])
	) as OptionalFields<F>;
}
