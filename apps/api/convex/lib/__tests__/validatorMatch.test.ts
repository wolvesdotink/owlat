/**
 * `matchesValidator` — Convex's own acceptance rules, applied to a value that
 * has already crossed a function boundary and lost its gate.
 *
 * The cases below are the ones a consumer gets wrong by hand: an extra key, a
 * `null` standing in for an object, an array standing in for a record, an
 * optional field carrying `undefined`, and a union member that matches on its
 * literal but fails on a sibling field.
 */

import { describe, expect, it } from 'vitest';
import { v } from 'convex/values';
import { matchesValidator } from '../validatorMatch';

describe('scalars', () => {
	it.each([
		[v.string(), 'x', true],
		[v.string(), 1, false],
		[v.float64(), 1.5, true],
		[v.float64(), '1.5', false],
		[v.boolean(), false, true],
		[v.boolean(), 0, false],
		[v.null(), null, true],
		[v.null(), undefined, false],
		[v.int64(), 1n, true],
		[v.int64(), 1, false],
		[v.any(), Symbol.iterator, true],
	])('%# matches by type', (validator, value, expected) => {
		expect(matchesValidator(validator, value)).toBe(expected);
	});

	it('reads a document id as the string it is on the wire', () => {
		// Table membership is a database question, not a shape one.
		expect(matchesValidator(v.id('emailSends'), 'anything')).toBe(true);
		expect(matchesValidator(v.id('emailSends'), 7)).toBe(false);
	});

	it('matches a literal by value, not by type', () => {
		expect(matchesValidator(v.literal('accepted'), 'accepted')).toBe(true);
		expect(matchesValidator(v.literal('accepted'), 'deferred')).toBe(false);
	});
});

describe('objects are EXACT, exactly as v.object is', () => {
	const validator = v.object({
		kind: v.literal('a'),
		count: v.number(),
		note: v.optional(v.string()),
	});

	it('accepts the declared fields', () => {
		expect(matchesValidator(validator, { kind: 'a', count: 1 })).toBe(true);
		expect(matchesValidator(validator, { kind: 'a', count: 1, note: 'hi' })).toBe(true);
	});

	it('refuses a key it never declared', () => {
		// The whole reason a hand-written check drifts: an extra field is exactly
		// what a value from a DIFFERENT build looks like.
		expect(matchesValidator(validator, { kind: 'a', count: 1, extra: true })).toBe(false);
	});

	it('refuses a missing required field', () => {
		expect(matchesValidator(validator, { kind: 'a' })).toBe(false);
	});

	it('treats undefined as ABSENT, for required and optional alike', () => {
		expect(matchesValidator(validator, { kind: 'a', count: 1, note: undefined })).toBe(true);
		expect(matchesValidator(validator, { kind: 'a', count: undefined })).toBe(false);
	});

	it('refuses null and arrays where an object is declared', () => {
		expect(matchesValidator(validator, null)).toBe(false);
		expect(matchesValidator(validator, [])).toBe(false);
	});
});

describe('containers', () => {
	it('checks every array element', () => {
		const validator = v.array(v.string());
		expect(matchesValidator(validator, ['a', 'b'])).toBe(true);
		expect(matchesValidator(validator, ['a', 2])).toBe(false);
		expect(matchesValidator(validator, 'a')).toBe(false);
	});

	it('checks record keys and values', () => {
		const validator = v.record(v.string(), v.number());
		expect(matchesValidator(validator, { a: 1 })).toBe(true);
		expect(matchesValidator(validator, { a: 'one' })).toBe(false);
		expect(matchesValidator(validator, [])).toBe(false);
	});

	it('accepts a union when ONE member accepts the whole value', () => {
		const validator = v.union(
			v.object({ kind: v.literal('a'), a: v.string() }),
			v.object({ kind: v.literal('b'), b: v.number() })
		);
		expect(matchesValidator(validator, { kind: 'a', a: 'x' })).toBe(true);
		expect(matchesValidator(validator, { kind: 'b', b: 1 })).toBe(true);
		// Right discriminant, wrong payload — the arm is not half-matched.
		expect(matchesValidator(validator, { kind: 'a', b: 1 })).toBe(false);
		expect(matchesValidator(validator, { kind: 'c' })).toBe(false);
	});

	it('descends into nesting rather than stopping at the top level', () => {
		const validator = v.object({ outer: v.object({ inner: v.array(v.literal(1)) }) });
		expect(matchesValidator(validator, { outer: { inner: [1, 1] } })).toBe(true);
		expect(matchesValidator(validator, { outer: { inner: [1, 2] } })).toBe(false);
	});
});
