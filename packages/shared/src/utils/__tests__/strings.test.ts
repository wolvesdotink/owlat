import { describe, it, expect } from 'vitest';
import { capitalize, initials, truncate } from '../strings';

describe('capitalize', () => {
	it('capitalizes the first letter', () => {
		expect(capitalize('hello')).toBe('Hello');
	});

	it('leaves already-capitalized strings unchanged', () => {
		expect(capitalize('Hello')).toBe('Hello');
	});

	it('handles single character strings', () => {
		expect(capitalize('a')).toBe('A');
	});

	it('returns empty string as-is', () => {
		expect(capitalize('')).toBe('');
	});

	it('preserves the rest of the string', () => {
		expect(capitalize('hELLO wORLD')).toBe('HELLO wORLD');
	});
});

describe('initials', () => {
	it('extracts initials from a full name', () => {
		expect(initials('John Doe')).toBe('JD');
	});

	it('returns single initial for single name', () => {
		expect(initials('John')).toBe('J');
	});

	it('defaults to max 2 initials', () => {
		expect(initials('John Michael Doe')).toBe('JM');
	});

	it('respects maxLength parameter', () => {
		expect(initials('John Michael Doe', 3)).toBe('JMD');
		expect(initials('John Michael Doe', 1)).toBe('J');
	});

	it('uppercases initials from lowercase names', () => {
		expect(initials('john doe')).toBe('JD');
	});

	it('returns empty string for empty input', () => {
		expect(initials('')).toBe('');
	});

	it('handles extra whitespace', () => {
		expect(initials('  John   Doe  ')).toBe('JD');
	});
});

describe('truncate', () => {
	it('returns string unchanged if within maxLength', () => {
		expect(truncate('hello', 10)).toBe('hello');
	});

	it('returns string unchanged if exactly maxLength', () => {
		expect(truncate('hello', 5)).toBe('hello');
	});

	it('truncates and appends default suffix', () => {
		expect(truncate('hello world', 8)).toBe('hello...');
	});

	it('uses custom suffix', () => {
		expect(truncate('hello world', 8, '…')).toBe('hello w…');
	});

	it('returns empty string as-is', () => {
		expect(truncate('', 5)).toBe('');
	});

	it('handles very small maxLength by slicing suffix', () => {
		expect(truncate('hello world', 2)).toBe('..');
		expect(truncate('hello world', 1)).toBe('.');
	});

	it('handles maxLength equal to suffix length', () => {
		expect(truncate('hello world', 3)).toBe('...');
	});
});
