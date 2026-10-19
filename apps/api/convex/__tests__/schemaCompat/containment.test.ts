import { v, type Validator, type ValidatorJSON } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { containmentGap, MAX_CASES, withoutValidatorField } from './containment';

/** The validator JSON a builder exports (convex keeps `json` out of the public types). */
const json = (validator: Validator<unknown, 'required', string>) =>
	(validator as unknown as { json: ValidatorJSON }).json;
const gap = (
	next: Validator<unknown, 'required', string>,
	previous: Validator<unknown, 'required', string>
) => containmentGap(json(next), json(previous));

describe('validator containment', () => {
	it('accepts the same validator and additive changes', () => {
		const args = v.object({ a: v.string(), b: v.optional(v.number()) });
		expect(gap(args, args)).toBeNull();
		expect(
			gap(v.object({ a: v.string(), b: v.optional(v.number()), c: v.optional(v.null()) }), args)
		).toBeNull();
		expect(gap(v.union(v.literal('a'), v.literal('b')), v.literal('a'))).toBeNull();
		expect(gap(v.string(), v.literal('a'))).toBeNull();
		expect(gap(v.number(), v.literal(1))).toBeNull();
		expect(gap(v.any(), v.object({ a: v.string() }))).toBeNull();
	});

	it('rejects scalar narrowing at any depth, which sample values miss', () => {
		expect(gap(v.object({ x: v.string() }), v.object({ x: v.any() }))).toBe(
			'x: accepted any, now only string'
		);
		expect(gap(v.object({ x: v.literal('fixture') }), v.object({ x: v.string() }))).toBe(
			'x: accepted string, now only "fixture"'
		);
		expect(gap(v.array(v.literal('fixture')), v.array(v.string()))).toBe(
			'[]: accepted string, now only "fixture"'
		);
		expect(gap(v.record(v.string(), v.literal('fixture')), v.record(v.string(), v.string()))).toBe(
			'{}: accepted string, now only "fixture"'
		);
		expect(gap(v.literal(1), v.number())).toBe('(value): accepted number, now only 1');
		expect(gap(v.string(), v.literal(1))).toBe('(value): accepted 1, now only string');
	});

	it('tells ids from strings and ids of one table from another', () => {
		expect(gap(v.id('users'), v.string())).toBe('(value): accepted string, now only id of users');
		expect(gap(v.string(), v.id('users'))).toBeNull();
		expect(gap(v.id('users'), v.id('users'))).toBeNull();
		expect(gap(v.id('contacts'), v.id('users'))).toBe(
			'(value): accepted id of users, now only id of contacts'
		);
	});

	it('rejects a union split that loses a combination of members', () => {
		const previous = v.object({
			a: v.union(v.literal('a'), v.literal('b')),
			b: v.union(v.literal('x'), v.literal('y')),
		});
		expect(
			gap(
				v.union(
					v.object({ a: v.literal('a'), b: v.union(v.literal('x'), v.literal('y')) }),
					v.object({ a: v.literal('b'), b: v.literal('x') })
				),
				previous
			)
		).toBe(
			'(value): accepted {a: "b", b: "y"}, now only {a: "a", b: "x" | "y"} | {a: "b", b: "x"}'
		);
		expect(
			gap(
				v.union(
					v.object({ a: v.literal('a'), b: v.union(v.literal('x'), v.literal('y')) }),
					v.object({ a: v.literal('b'), b: v.union(v.literal('x'), v.literal('y')) })
				),
				previous
			)
		).toBeNull();
	});

	it('proves containment by a union through present/absent optionals and booleans', () => {
		expect(
			gap(
				v.union(v.object({ x: v.string() }), v.object({})),
				v.object({ x: v.optional(v.string()) })
			)
		).toBeNull();
		expect(gap(v.union(v.literal(true), v.literal(false)), v.boolean())).toBeNull();
		expect(gap(v.literal(true), v.boolean())).toBe('(value): accepted boolean, now only true');
		expect(
			gap(
				v.union(
					v.object({ on: v.literal(true) }),
					v.object({ on: v.literal(false), at: v.number() })
				),
				v.object({ on: v.boolean() })
			)
		).toBe('(value): accepted {on: false}, now only {on: true} | {on: false, at: number}');
	});

	it('follows Convex object rules: no extra fields, no new required ones', () => {
		expect(
			gap(v.object({ a: v.string() }), v.object({ a: v.string(), b: v.optional(v.string()) }))
		).toBe('b: no longer accepted');
		expect(gap(v.object({ a: v.string(), b: v.string() }), v.object({ a: v.string() }))).toBe(
			'b: new and required'
		);
		expect(
			gap(
				v.object({ a: v.object({ b: v.string() }) }),
				v.object({ a: v.object({ b: v.optional(v.string()) }) })
			)
		).toBe('a.b: optional, now required');
		expect(gap(v.record(v.string(), v.string()), v.object({ a: v.string() }))).toBe(
			'(value): accepted {a: string}, now only record'
		);
	});

	it('counts what it cannot prove as a gap', () => {
		const flags = Object.fromEntries(
			Array.from({ length: Math.log2(MAX_CASES) + 1 }, (_, i) => [`f${i}`, v.boolean()])
		);
		// Every case does fit one member, but there are more cases than the bound.
		expect(
			gap(
				v.union(
					v.object({ ...flags, f0: v.literal(true) }),
					v.object({ ...flags, f0: v.literal(false) })
				),
				v.object(flags)
			)
		).toMatch(/^\(value\): too many cases to prove/);
		const unknown = { type: 'future' } as unknown as ValidatorJSON;
		expect(containmentGap(json(v.string()), unknown)).toBe(
			'(value): accepted future, now only string'
		);
		expect(gap(v.object({}), v.any())).toBe('(value): accepted any, now only {}');
	});
});

describe('removing a retired field from a validator', () => {
	it('removes it through arrays and in every union member, and keeps the rest', () => {
		const previous = json(
			v.object({
				items: v.array(
					v.union(
						v.object({ id: v.string(), legacy: v.string() }),
						v.object({ id: v.number(), legacy: v.optional(v.string()) })
					)
				),
				at: v.number(),
			})
		);
		expect(withoutValidatorField(previous, 'items[].legacy')).toEqual(
			json(
				v.object({
					items: v.array(v.union(v.object({ id: v.string() }), v.object({ id: v.number() }))),
					at: v.number(),
				})
			)
		);
		expect(withoutValidatorField(previous, 'at')).toEqual(
			json(
				v.object({
					items: v.array(
						v.union(
							v.object({ id: v.string(), legacy: v.string() }),
							v.object({ id: v.number(), legacy: v.optional(v.string()) })
						)
					),
				})
			)
		);
		expect(withoutValidatorField(previous, 'missing')).toEqual(previous);
	});
});
