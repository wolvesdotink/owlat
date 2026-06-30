import { describe, it, expect } from 'vitest';
import { isValidEmail, validateStringLength, sanitizeEmailHeaderValue, isSafeRedirectUrl } from '../inputGuards';

describe('isValidEmail', () => {
	it('returns true for valid emails', () => {
		expect(isValidEmail('user@example.com')).toBe(true);
		expect(isValidEmail('user+tag@example.com')).toBe(true);
		expect(isValidEmail('user@sub.domain.com')).toBe(true);
	});

	it('returns false for emails without @', () => {
		expect(isValidEmail('userexample.com')).toBe(false);
	});

	it('returns false for emails without domain', () => {
		expect(isValidEmail('user@')).toBe(false);
	});

	it('returns false for emails with spaces', () => {
		expect(isValidEmail('user @example.com')).toBe(false);
		expect(isValidEmail('user@ example.com')).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(isValidEmail('')).toBe(false);
	});

	it('returns false for emails without TLD part', () => {
		expect(isValidEmail('user@domain')).toBe(false);
	});
});

describe('validateStringLength', () => {
	it('does not throw for strings within limit', () => {
		expect(() => validateStringLength('hello', 10, 'Test')).not.toThrow();
	});

	it('does not throw for strings at exact limit', () => {
		expect(() => validateStringLength('12345', 5, 'Test')).not.toThrow();
	});

	it('throws for strings exceeding limit', () => {
		expect(() => validateStringLength('123456', 5, 'Name')).toThrow(
			'Name must be at most 5 characters'
		);
	});

	it('does not throw for empty string', () => {
		expect(() => validateStringLength('', 5, 'Test')).not.toThrow();
	});
});

describe('sanitizeEmailHeaderValue', () => {
	it('passes through normal strings', () => {
		expect(sanitizeEmailHeaderValue('John Doe')).toBe('John Doe');
	});

	it('strips newlines (header injection prevention)', () => {
		expect(sanitizeEmailHeaderValue('John\r\nBcc: attacker@evil.com')).toBe(
			'JohnBcc: attacker@evil.com'
		);
	});

	it('strips carriage return', () => {
		expect(sanitizeEmailHeaderValue('John\rDoe')).toBe('JohnDoe');
	});

	it('strips newline', () => {
		expect(sanitizeEmailHeaderValue('John\nDoe')).toBe('JohnDoe');
	});

	it('strips null bytes', () => {
		expect(sanitizeEmailHeaderValue('John\x00Doe')).toBe('JohnDoe');
	});

	it('strips control characters', () => {
		expect(sanitizeEmailHeaderValue('John\x01\x02\x03Doe')).toBe('JohnDoe');
	});

	it('collapses multiple spaces', () => {
		expect(sanitizeEmailHeaderValue('John   Doe')).toBe('John Doe');
	});

	it('trims whitespace', () => {
		expect(sanitizeEmailHeaderValue('  John Doe  ')).toBe('John Doe');
	});

	it('truncates to 200 characters', () => {
		const long = 'A'.repeat(250);
		expect(sanitizeEmailHeaderValue(long)).toBe('A'.repeat(200));
	});

	it('handles empty string', () => {
		expect(sanitizeEmailHeaderValue('')).toBe('');
	});
});

describe('isSafeRedirectUrl', () => {
	it('allows http URLs', () => {
		expect(isSafeRedirectUrl('http://example.com/callback')).toBe(true);
	});

	it('allows https URLs', () => {
		expect(isSafeRedirectUrl('https://example.com/callback')).toBe(true);
	});

	it('rejects javascript: protocol', () => {
		expect(isSafeRedirectUrl('javascript:alert(1)')).toBe(false);
	});

	it('rejects data: protocol', () => {
		expect(isSafeRedirectUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
	});

	it('rejects invalid URLs', () => {
		expect(isSafeRedirectUrl('not a url')).toBe(false);
	});

	it('rejects ftp protocol', () => {
		expect(isSafeRedirectUrl('ftp://example.com')).toBe(false);
	});
});
