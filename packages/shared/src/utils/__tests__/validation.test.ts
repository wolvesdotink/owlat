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
} from '../validation';

describe('isValidEmail', () => {
	it('accepts valid emails', () => {
		expect(isValidEmail('user@example.com')).toBe(true);
		expect(isValidEmail('first.last@example.com')).toBe(true);
		expect(isValidEmail('user+tag@example.com')).toBe(true);
		expect(isValidEmail('user@sub.domain.com')).toBe(true);
		expect(isValidEmail('user@example.co.uk')).toBe(true);
	});

	it('rejects emails with consecutive dots in local part', () => {
		expect(isValidEmail('user..name@example.com')).toBe(false);
	});

	it('rejects emails without TLD', () => {
		expect(isValidEmail('user@localhost')).toBe(false);
	});

	it('rejects emails with single-char TLD', () => {
		expect(isValidEmail('user@example.c')).toBe(false);
	});

	it('rejects emails without @ sign', () => {
		expect(isValidEmail('userexample.com')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidEmail('')).toBe(false);
	});

	it('rejects emails with spaces', () => {
		expect(isValidEmail('user @example.com')).toBe(false);
	});

	// X3 — SMTPUTF8 / EAI (RFC 6531/6532). Internationalized addresses must no
	// longer be rejected at contact import / validation.
	it('accepts internationalized (EAI) addresses', () => {
		expect(isValidEmail('用户@example.com')).toBe(true); // non-ASCII local-part
		expect(isValidEmail('пользователь@example.com')).toBe(true);
		expect(isValidEmail('Pelé@example.com')).toBe(true);
		expect(isValidEmail('user@例え.test')).toBe(true); // non-ASCII (U-label) domain
		expect(isValidEmail('用户@例え.テスト')).toBe(true); // non-ASCII local-part + domain + TLD
	});

	it('still enforces ASCII structural rules on internationalized addresses', () => {
		// A non-ASCII local-part does not relax dot/hyphen/TLD structure.
		expect(isValidEmail('用户..name@example.com')).toBe(false); // consecutive dots
		expect(isValidEmail('用户@localhost')).toBe(false); // no TLD
		expect(isValidEmail('用户 name@example.com')).toBe(false); // space
	});

	it('rejects invisible / control / separator code points (the Unicode analogue of the space rule)', () => {
		// The \p{C} (control/format/surrogate/…) and \p{Z} (space/separator) classes are
		// subtracted from the accepted non-ASCII range, so these spoof/mangle vectors —
		// the Unicode equivalents of the pinned ASCII-space rejection — do NOT pass.
		const cp = (c: number): string => String.fromCodePoint(c);
		expect(isValidEmail(`user${cp(0xa0)}name@example.com`)).toBe(false); // U+00A0 NBSP
		expect(isValidEmail(`user${cp(0x200b)}name@example.com`)).toBe(false); // U+200B ZWSP
		expect(isValidEmail(`user@ex${cp(0x2028)}ample.com`)).toBe(false); // U+2028 line separator
		expect(isValidEmail(`user@ex${cp(0x2029)}ample.com`)).toBe(false); // U+2029 paragraph separator
		expect(isValidEmail(`user@x${cp(0x85)}.com`)).toBe(false); // U+0085 NEL (control)
		expect(isValidEmail(`user@ex${cp(0x202e)}ample.com`)).toBe(false); // U+202E RLO (BiDi override)
		expect(isValidEmail(`us${cp(0x202a)}er@example.com`)).toBe(false); // U+202A LRE (BiDi override)
	});
});

describe('isValidDomain', () => {
	it('accepts valid domains', () => {
		expect(isValidDomain('example.com')).toBe(true);
		expect(isValidDomain('sub.example.com')).toBe(true);
		expect(isValidDomain('my-site.org')).toBe(true);
		expect(isValidDomain('example.co.uk')).toBe(true);
	});

	it('rejects domains with leading hyphen', () => {
		expect(isValidDomain('-example.com')).toBe(false);
	});

	it('rejects domains without TLD', () => {
		expect(isValidDomain('example')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidDomain('')).toBe(false);
	});

	it('rejects domains with spaces', () => {
		expect(isValidDomain('exam ple.com')).toBe(false);
	});
});

describe('isValidUrl', () => {
	it('accepts valid http URLs', () => {
		expect(isValidUrl('http://example.com')).toBe(true);
	});

	it('accepts valid https URLs', () => {
		expect(isValidUrl('https://example.com')).toBe(true);
		expect(isValidUrl('https://example.com/path?query=1#hash')).toBe(true);
	});

	it('rejects strings without protocol', () => {
		expect(isValidUrl('example.com')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidUrl('')).toBe(false);
	});

	it('rejects random text', () => {
		expect(isValidUrl('not a url at all')).toBe(false);
	});
});

describe('isValidPhone', () => {
	it('accepts international format numbers', () => {
		expect(isValidPhone('+14155552671')).toBe(true);
		expect(isValidPhone('+441234567890')).toBe(true);
		expect(isValidPhone('14155552671')).toBe(true);
	});

	it('strips formatting characters before validation', () => {
		expect(isValidPhone('+1 (415) 555-2671')).toBe(true);
		expect(isValidPhone('+1-415-555-2671')).toBe(true);
	});

	it('rejects numbers starting with 0', () => {
		expect(isValidPhone('0123456789')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidPhone('')).toBe(false);
	});
});

describe('isValidSlug', () => {
	it('accepts valid slugs', () => {
		expect(isValidSlug('hello-world')).toBe(true);
		expect(isValidSlug('hello')).toBe(true);
		expect(isValidSlug('my-long-slug-123')).toBe(true);
		expect(isValidSlug('a1b2c3')).toBe(true);
	});

	it('rejects uppercase characters', () => {
		expect(isValidSlug('Hello')).toBe(false);
	});

	it('rejects special characters', () => {
		expect(isValidSlug('hello_world')).toBe(false);
		expect(isValidSlug('hello world')).toBe(false);
		expect(isValidSlug('hello.world')).toBe(false);
	});

	it('rejects leading or trailing hyphens', () => {
		expect(isValidSlug('-hello')).toBe(false);
		expect(isValidSlug('hello-')).toBe(false);
	});

	it('rejects consecutive hyphens', () => {
		expect(isValidSlug('hello--world')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isValidSlug('')).toBe(false);
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
		expect(isEmpty('\t\n')).toBe(true);
	});

	it('returns false for non-empty string', () => {
		expect(isEmpty('hello')).toBe(false);
		expect(isEmpty(' hello ')).toBe(false);
	});
});

describe('isNonEmptyString', () => {
	it('returns true for non-empty strings', () => {
		expect(isNonEmptyString('hello')).toBe(true);
		expect(isNonEmptyString(' a ')).toBe(true);
	});

	it('returns false for empty strings', () => {
		expect(isNonEmptyString('')).toBe(false);
		expect(isNonEmptyString('   ')).toBe(false);
	});

	it('returns false for non-string types', () => {
		expect(isNonEmptyString(null)).toBe(false);
		expect(isNonEmptyString(undefined)).toBe(false);
		expect(isNonEmptyString(123)).toBe(false);
		expect(isNonEmptyString({})).toBe(false);
		expect(isNonEmptyString([])).toBe(false);
	});
});

describe('toSlug', () => {
	it('converts uppercase to lowercase', () => {
		expect(toSlug('Hello World')).toBe('hello-world');
	});

	it('replaces spaces with hyphens', () => {
		expect(toSlug('hello world')).toBe('hello-world');
	});

	it('removes special characters', () => {
		expect(toSlug('Hello, World!')).toBe('hello-world');
	});

	it('replaces underscores with hyphens', () => {
		expect(toSlug('hello_world')).toBe('hello-world');
	});

	it('collapses multiple separators', () => {
		expect(toSlug('hello   world')).toBe('hello-world');
		expect(toSlug('hello---world')).toBe('hello-world');
	});

	it('trims leading and trailing hyphens', () => {
		expect(toSlug(' hello world ')).toBe('hello-world');
		expect(toSlug('--hello--')).toBe('hello');
	});

	it('handles already-valid slugs', () => {
		expect(toSlug('hello-world')).toBe('hello-world');
	});
});
