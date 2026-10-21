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
import { matchesValidator, validatorMismatch } from '../validatorMatch';

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

describe('validatorMismatch names the place, never the value', () => {
	const validator = v.object({
		kind: v.literal('credentials'),
		credentials: v.object({ imapPort: v.number(), imapPassword: v.string() }),
	});

	it('answers null for a match', () => {
		expect(
			validatorMismatch(validator, {
				kind: 'credentials',
				credentials: { imapPort: 993, imapPassword: 'hunter2' },
			})
		).toBeNull();
	});

	it('walks to the first failing field', () => {
		const report = validatorMismatch(validator, {
			kind: 'credentials',
			credentials: { imapPort: '993', imapPassword: 'hunter2' },
		});
		expect(report).toBe('$.credentials.imapPort: expected float64');
	});

	it('never repeats a value it was handed', () => {
		// The credential bundle crosses this check; a report is a log line.
		const secret = 'correct-horse-battery-staple';
		const reports = [
			validatorMismatch(validator, { kind: secret }),
			validatorMismatch(validator, { kind: 'credentials', credentials: { imapPort: secret } }),
			validatorMismatch(validator, {
				kind: 'credentials',
				credentials: { imapPort: 1, imapPassword: 2, [secret]: secret },
			}),
			validatorMismatch(v.array(v.number()), [1, secret]),
			validatorMismatch(v.record(v.string(), v.number()), { a: secret }),
		];
		for (const report of reports) {
			expect(report).not.toBeNull();
			expect(report).not.toContain(secret);
		}
	});

	it('names a missing field, an unexpected field and an unmatched union', () => {
		expect(validatorMismatch(validator, { kind: 'credentials' })).toBe('$.credentials: missing');
		expect(validatorMismatch(v.object({ a: v.number() }), { a: 1, b: 2 })).toBe(
			'$: unexpected field'
		);
		expect(validatorMismatch(v.union(v.null(), v.number()), 'x')).toBe(
			'$: matches no member of the union'
		);
		expect(validatorMismatch(v.array(v.number()), [1, 'x'])).toBe('$[1]: expected float64');
	});

	it('fails closed on a validator kind it does not know', () => {
		const future = { kind: 'commitTs', isOptional: 'required' } as unknown as Parameters<
			typeof validatorMismatch
		>[0];
		expect(validatorMismatch(future, 1)).toMatch(/cannot be checked/);
	});
});

describe("unknownKeys: 'ignore' — a consumer reading a newer producer", () => {
	const validator = v.object({ count: v.number(), note: v.optional(v.string()) });

	it('lets a field it never declared through, untouched', () => {
		const value = { count: 1, addedNextRelease: true };
		expect(matchesValidator(validator, value, { unknownKeys: 'ignore' })).toBe(true);
		expect(value).toEqual({ count: 1, addedNextRelease: true });
		// The default stays Convex's exact rule.
		expect(matchesValidator(validator, value)).toBe(false);
	});

	it('still checks every declared field, at every depth', () => {
		const ignore = { unknownKeys: 'ignore' } as const;
		expect(matchesValidator(validator, { extra: 1 }, ignore)).toBe(false);
		expect(matchesValidator(validator, { count: '1', extra: 1 }, ignore)).toBe(false);
		expect(matchesValidator(validator, { count: 1, note: 2 }, ignore)).toBe(false);
		const nested = v.object({ rows: v.array(v.object({ uid: v.number() })) });
		expect(matchesValidator(nested, { rows: [{ uid: 1, more: 'x' }] }, ignore)).toBe(true);
		expect(matchesValidator(nested, { rows: [{ more: 'x' }] }, ignore)).toBe(false);
	});

	it('does not let an unknown key decide between union members', () => {
		const union = v.union(
			v.object({ kind: v.literal('a'), a: v.string() }),
			v.object({ kind: v.literal('b'), b: v.number() })
		);
		const ignore = { unknownKeys: 'ignore' } as const;
		expect(matchesValidator(union, { kind: 'a', a: 'x', b: 1 }, ignore)).toBe(true);
		expect(matchesValidator(union, { kind: 'c', a: 'x' }, ignore)).toBe(false);
	});
});
