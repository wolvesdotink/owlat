import { describe, expect, it } from 'vitest';
import { readOwnProperty, readOwnString } from '../objectAccess';

describe('readOwnString', () => {
	it('reads an own-enumerable string property', () => {
		expect(readOwnString({ messageId: 'm-1' }, 'messageId')).toBe('m-1');
	});

	it('treats an empty string as absent by default (gate-handler behaviour)', () => {
		expect(readOwnString({ subject: '' }, 'subject')).toBeUndefined();
	});

	it('returns the empty string when allowEmpty is set (notifier behaviour)', () => {
		expect(readOwnString({ subject: '' }, 'subject', { allowEmpty: true })).toBe('');
	});

	it('ignores non-string values', () => {
		expect(readOwnString({ messageId: 42 }, 'messageId')).toBeUndefined();
		expect(readOwnString({ messageId: null }, 'messageId')).toBeUndefined();
	});

	it('ignores inherited keys — only own properties are read', () => {
		const base = { messageId: 'inherited' };
		const derived = Object.create(base) as Record<string, unknown>;
		expect(readOwnString(derived, 'messageId')).toBeUndefined();
	});

	it('ignores a non-enumerable own property', () => {
		const target = {};
		Object.defineProperty(target, 'messageId', { value: 'hidden', enumerable: false });
		expect(readOwnString(target, 'messageId')).toBeUndefined();
	});

	it('ignores an accessor property (never invokes a getter)', () => {
		let invoked = false;
		const target = {};
		Object.defineProperty(target, 'messageId', {
			enumerable: true,
			get() {
				invoked = true;
				return 'from-getter';
			},
		});
		expect(readOwnString(target, 'messageId')).toBeUndefined();
		expect(invoked).toBe(false);
	});

	it('returns undefined for non-objects and arrays', () => {
		expect(readOwnString(null, 'k')).toBeUndefined();
		expect(readOwnString('str', 'k')).toBeUndefined();
		expect(readOwnString(['x'], '0')).toBeUndefined();
	});
});

describe('readOwnProperty', () => {
	it('reads an own-enumerable value of any type', () => {
		expect(readOwnProperty({ payload: { a: 1 } }, 'payload')).toEqual({ a: 1 });
		expect(readOwnProperty({ payload: 0 }, 'payload')).toBe(0);
	});

	it('returns undefined for an absent, inherited, or non-object source', () => {
		expect(readOwnProperty({}, 'payload')).toBeUndefined();
		expect(readOwnProperty(Object.create({ payload: 1 }), 'payload')).toBeUndefined();
		expect(readOwnProperty(null, 'payload')).toBeUndefined();
	});
});
