import { describe, it, expect } from 'vitest';
import { normalizeError } from '../errors';

describe('normalizeError', () => {
	it('returns Error instances as-is', () => {
		const err = new Error('test');
		expect(normalizeError(err)).toBe(err);
	});

	it('preserves Error subclass instances', () => {
		const err = new TypeError('type error');
		expect(normalizeError(err)).toBe(err);
		expect(normalizeError(err)).toBeInstanceOf(TypeError);
	});

	it('wraps a string in an Error', () => {
		const result = normalizeError('something went wrong');
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('something went wrong');
	});

	it('wraps an object with a message property', () => {
		const result = normalizeError({ message: 'object error' });
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('object error');
	});

	it('ignores object with non-string message property', () => {
		const result = normalizeError({ message: 123 });
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('[object Object]');
	});

	it('wraps null using String conversion', () => {
		const result = normalizeError(null);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('null');
	});

	it('wraps undefined using String conversion', () => {
		const result = normalizeError(undefined);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('undefined');
	});

	it('wraps a number using String conversion', () => {
		const result = normalizeError(42);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('42');
	});

	it('wraps a boolean using String conversion', () => {
		const result = normalizeError(false);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('false');
	});
});
