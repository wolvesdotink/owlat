import { describe, it, expect } from 'vitest';
import { errorMessage } from '../errors';

describe('errorMessage', () => {
	it('returns the message of an Error', () => {
		expect(errorMessage(new Error('boom'))).toBe('boom');
		expect(errorMessage(new TypeError('typed'))).toBe('typed');
	});

	it('reads a message property from a plain object', () => {
		expect(errorMessage({ message: 'nope' })).toBe('nope');
		expect(errorMessage({ message: 404 })).toBe('404');
	});

	it('stringifies everything else', () => {
		expect(errorMessage('raw string')).toBe('raw string');
		expect(errorMessage(42)).toBe('42');
		expect(errorMessage(null)).toBe('null');
		expect(errorMessage(undefined)).toBe('undefined');
		expect(errorMessage(['message'])).toBe('message');
	});
});
