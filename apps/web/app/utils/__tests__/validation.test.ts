import { describe, it, expect } from 'vitest';
import {
	isValidEmail,
	isValidDomain,
	isValidUrl,
	isValidPhone,
	isValidSlug,
	isEmpty,
	isNonEmptyString,
	toSlug,
	truncate,
} from '../validation';

describe('isValidEmail', () => {
	it('accepts standard email', () => {
		expect(isValidEmail('user@example.com')).toBe(true);
	});

	it('accepts email with subdomain', () => {
		expect(isValidEmail('user@mail.example.com')).toBe(true);
	});

	it('accepts email with plus tag', () => {
		expect(isValidEmail('user+tag@example.com')).toBe(true);
	});

	it('rejects missing @', () => {
		expect(isValidEmail('userexample.com')).toBe(false);
	});

	it('rejects missing domain', () => {
		expect(isValidEmail('user@')).toBe(false);
	});

	it('rejects missing TLD', () => {
		expect(isValidEmail('user@example')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidEmail('')).toBe(false);
	});

	it('rejects spaces', () => {
		expect(isValidEmail('user @example.com')).toBe(false);
	});
});

describe('isValidDomain', () => {
	it('accepts standard domain', () => {
		expect(isValidDomain('example.com')).toBe(true);
	});

	it('accepts multi-level TLD', () => {
		expect(isValidDomain('example.co.uk')).toBe(true);
	});

	it('accepts subdomain', () => {
		expect(isValidDomain('mail.example.com')).toBe(true);
	});

	it('rejects domain starting with hyphen', () => {
		expect(isValidDomain('-example.com')).toBe(false);
	});

	it('rejects domain with spaces', () => {
		expect(isValidDomain('exam ple.com')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidDomain('')).toBe(false);
	});
});

describe('isValidUrl', () => {
	it('accepts https URL', () => {
		expect(isValidUrl('https://example.com')).toBe(true);
	});

	it('accepts http URL', () => {
		expect(isValidUrl('http://example.com')).toBe(true);
	});

	it('accepts URL with path', () => {
		expect(isValidUrl('https://example.com/path/to/page')).toBe(true);
	});

	it('rejects invalid string', () => {
		expect(isValidUrl('not a url')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidUrl('')).toBe(false);
	});
});

describe('isValidPhone', () => {
	it('accepts international format', () => {
		expect(isValidPhone('+14155551234')).toBe(true);
	});

	it('strips whitespace and parens', () => {
		expect(isValidPhone('+1 (415) 555-1234')).toBe(true);
	});

	it('accepts number without plus', () => {
		expect(isValidPhone('14155551234')).toBe(true);
	});

	it('rejects too short number', () => {
		expect(isValidPhone('+1')).toBe(false);
	});

	it('rejects letters', () => {
		expect(isValidPhone('+1abc5551234')).toBe(false);
	});
});

describe('isValidSlug', () => {
	it('accepts lowercase letters and hyphens', () => {
		expect(isValidSlug('hello-world')).toBe(true);
	});

	it('accepts lowercase with numbers', () => {
		expect(isValidSlug('page-1')).toBe(true);
	});

	it('accepts single word', () => {
		expect(isValidSlug('hello')).toBe(true);
	});

	it('rejects uppercase', () => {
		expect(isValidSlug('Hello-World')).toBe(false);
	});

	it('rejects spaces', () => {
		expect(isValidSlug('hello world')).toBe(false);
	});

	it('rejects trailing hyphen', () => {
		expect(isValidSlug('hello-')).toBe(false);
	});

	it('rejects leading hyphen', () => {
		expect(isValidSlug('-hello')).toBe(false);
	});
});

describe('isEmpty', () => {
	it('returns true for null', () => {
		expect(isEmpty(null)).toBe(true);
	});

	it('returns true for undefined', () => {
		expect(isEmpty(undefined)).toBe(true);
	});

	it('returns true for empty string', () => {
		expect(isEmpty('')).toBe(true);
	});

	it('returns true for whitespace-only string', () => {
		expect(isEmpty('   ')).toBe(true);
	});

	it('returns false for non-empty string', () => {
		expect(isEmpty('hello')).toBe(false);
	});

	it('returns false for string with whitespace and content', () => {
		expect(isEmpty(' hello ')).toBe(false);
	});
});

describe('isNonEmptyString', () => {
	it('returns true for non-empty string', () => {
		expect(isNonEmptyString('hello')).toBe(true);
	});

	it('returns false for empty string', () => {
		expect(isNonEmptyString('')).toBe(false);
	});

	it('returns false for whitespace-only string', () => {
		expect(isNonEmptyString('   ')).toBe(false);
	});

	it('returns false for number', () => {
		expect(isNonEmptyString(42)).toBe(false);
	});

	it('returns false for null', () => {
		expect(isNonEmptyString(null)).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isNonEmptyString(undefined)).toBe(false);
	});

	it('returns false for object', () => {
		expect(isNonEmptyString({})).toBe(false);
	});
});

describe('toSlug', () => {
	it('lowercases input', () => {
		expect(toSlug('Hello World')).toBe('hello-world');
	});

	it('strips special characters', () => {
		expect(toSlug('Hello! @World#')).toBe('hello-world');
	});

	it('collapses multiple hyphens', () => {
		expect(toSlug('hello---world')).toBe('hello-world');
	});

	it('trims leading and trailing hyphens', () => {
		expect(toSlug('--hello-world--')).toBe('hello-world');
	});

	it('replaces underscores with hyphens', () => {
		expect(toSlug('hello_world')).toBe('hello-world');
	});

	it('handles whitespace', () => {
		expect(toSlug('  hello   world  ')).toBe('hello-world');
	});

	it('handles empty string', () => {
		expect(toSlug('')).toBe('');
	});
});

describe('truncate', () => {
	it('returns original when under max length', () => {
		expect(truncate('hello', 10)).toBe('hello');
	});

	it('returns original when exactly at max length', () => {
		expect(truncate('hello', 5)).toBe('hello');
	});

	it('truncates with default suffix', () => {
		expect(truncate('hello world', 8)).toBe('hello...');
	});

	it('truncates with custom suffix', () => {
		expect(truncate('hello world', 7, '~')).toBe('hello ~');
	});

	it('handles very short maxLength', () => {
		expect(truncate('hello world', 4)).toBe('h...');
	});
});
