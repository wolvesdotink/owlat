import { describe, it, expect } from 'vitest';
import {
	isValidEmail,
	isJsonPrimitiveRecord,
	isValidConvexId,
	safeDecodeURIComponent,
	validateStringLength,
	sanitizeEmailHeaderValue,
	isSafeRedirectUrl,
} from '../inputGuards';

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

describe('isValidConvexId', () => {
	it('should accept Convex-shaped IDs (>=10 alphanumeric/underscore chars)', () => {
		expect(isValidConvexId('abc1234567')).toBe(true);
	});

	it('should accept IDs with hyphens (URL-safe base64 alphabet)', () => {
		expect(isValidConvexId('abc-1234567')).toBe(true);
	});

	it('should accept uppercase letters', () => {
		expect(isValidConvexId('ABC1234567')).toBe(true);
	});

	it('should accept mixed case with underscores', () => {
		expect(isValidConvexId('Ab_Cd_1234')).toBe(true);
	});

	it('should reject empty string', () => {
		expect(isValidConvexId('')).toBe(false);
	});

	it('should reject IDs with spaces', () => {
		expect(isValidConvexId('abc 1234567')).toBe(false);
	});

	it('should reject too-short IDs (under 10 chars)', () => {
		expect(isValidConvexId('abc123')).toBe(false);
		expect(isValidConvexId('abc-123')).toBe(false);
		expect(isValidConvexId('a')).toBe(false);
		expect(isValidConvexId('1')).toBe(false);
	});

	it('should reject IDs with dots', () => {
		expect(isValidConvexId('abc.1234567')).toBe(false);
	});

	it('should reject IDs with special characters', () => {
		expect(isValidConvexId('abc@1234567')).toBe(false);
		expect(isValidConvexId('abc!1234567')).toBe(false);
		expect(isValidConvexId('abc#1234567')).toBe(false);
	});

	it('should reject email addresses', () => {
		expect(isValidConvexId('user@example.com')).toBe(false);
	});

	it('should accept long IDs', () => {
		expect(isValidConvexId('a'.repeat(100))).toBe(true);
	});

	it('should reject IDs with slashes', () => {
		expect(isValidConvexId('abc/1234567')).toBe(false);
	});
});

describe('safeDecodeURIComponent', () => {
	it('decodes valid percent-encoding', () => {
		expect(safeDecodeURIComponent('user%40example.com')).toBe('user@example.com');
	});

	it('returns null instead of throwing on malformed percent-encoding', () => {
		expect(safeDecodeURIComponent('%E0%A4%A')).toBeNull();
		expect(safeDecodeURIComponent('%')).toBeNull();
	});
});

describe('isJsonPrimitiveRecord', () => {
	it('accepts a flat object of primitives, including null and the empty object', () => {
		expect(isJsonPrimitiveRecord({ a: 'x', b: 1, c: true, d: null })).toBe(true);
		expect(isJsonPrimitiveRecord({})).toBe(true);
	});

	it('rejects nested values', () => {
		expect(isJsonPrimitiveRecord({ a: { b: 1 } })).toBe(false);
		expect(isJsonPrimitiveRecord({ a: [1] })).toBe(false);
	});

	it('rejects non-objects, null and arrays', () => {
		expect(isJsonPrimitiveRecord(null)).toBe(false);
		expect(isJsonPrimitiveRecord('x')).toBe(false);
		expect(isJsonPrimitiveRecord([])).toBe(false);
	});
});
