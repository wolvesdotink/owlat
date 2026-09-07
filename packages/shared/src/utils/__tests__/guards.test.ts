import { describe, expect, it } from 'vitest';
import { isPlainObject, isRecord } from '../guards';

describe('isRecord', () => {
	it('accepts plain and prototype-less objects', () => {
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(Object.create(null))).toBe(true);
		expect(isRecord(new Date())).toBe(true);
	});

	it('rejects null, arrays and primitives', () => {
		expect(isRecord(null)).toBe(false);
		expect(isRecord(undefined)).toBe(false);
		expect(isRecord([])).toBe(false);
		expect(isRecord(['message'])).toBe(false);
		expect(isRecord('text')).toBe(false);
		expect(isRecord(42)).toBe(false);
	});
});

describe('isPlainObject', () => {
	it('accepts object literals and prototype-less objects', () => {
		expect(isPlainObject({ a: 1 })).toBe(true);
		expect(isPlainObject(Object.create(null))).toBe(true);
	});

	it('rejects arrays, class instances, null and primitives', () => {
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject(new Date())).toBe(false);
		expect(isPlainObject(new Map())).toBe(false);
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject('text')).toBe(false);
	});
});
