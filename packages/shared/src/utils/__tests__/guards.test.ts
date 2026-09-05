import { describe, expect, it } from 'vitest';
import { isRecord } from '../guards';

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
