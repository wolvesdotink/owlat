import { describe, expect, it } from 'vitest';
import { assertPlainObject, EscalationConfigError, readOwnValue } from '../config';

describe('assertPlainObject', () => {
	it('accepts a plain object and a null-prototype object', () => {
		expect(() => assertPlainObject({}, 'nope')).not.toThrow();
		expect(() => assertPlainObject(Object.create(null) as object, 'nope')).not.toThrow();
	});

	it('rejects everything that is not a plain object, with the caller message', () => {
		// An object whose prototype is neither Object.prototype nor null.
		const instance: object = Object.create({ kind: 'config' });
		for (const value of [null, undefined, 1, 'x', true, [], instance, new Date()]) {
			expect(() => assertPlainObject(value, 'bad config'), String(value)).toThrow(
				EscalationConfigError
			);
			expect(() => assertPlainObject(value, 'bad config')).toThrow('bad config');
		}
	});
});

describe('readOwnValue', () => {
	it('reads an own data property', () => {
		expect(readOwnValue({ a: 1 }, 'a')).toBe(1);
	});

	it('never runs a getter', () => {
		let called = false;
		const raw = Object.defineProperty({}, 'a', {
			enumerable: true,
			get() {
				called = true;
				return 'leaked';
			},
		});
		expect(readOwnValue(raw, 'a')).toBeUndefined();
		expect(called).toBe(false);
	});

	it('does not resolve an inherited property', () => {
		const raw = Object.create({ a: 'inherited' }) as object;
		expect(readOwnValue(raw, 'a')).toBeUndefined();
	});

	it('returns undefined for an absent key', () => {
		expect(readOwnValue({}, 'missing')).toBeUndefined();
	});
});
