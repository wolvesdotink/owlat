import { describe, it, expect } from 'vitest';
import { parseStsPolicy, isMxAllowed } from '../smtp/mtaSts.js';

describe('MTA-STS policy parser', () => {
	it('should parse a valid enforce policy', () => {
		const text = `version: STSv1
mode: enforce
mx: *.google.com
mx: mail.google.com
max_age: 86400`;

		const policy = parseStsPolicy(text, 'test-id');
		expect(policy.mode).toBe('enforce');
		expect(policy.mx).toEqual(['*.google.com', 'mail.google.com']);
		expect(policy.maxAge).toBe(86400);
		expect(policy.version).toBe('test-id');
	});

	it('should parse a testing policy', () => {
		const text = `version: STSv1
mode: testing
mx: *.example.com
max_age: 604800`;

		const policy = parseStsPolicy(text, 'v2');
		expect(policy.mode).toBe('testing');
		expect(policy.mx).toEqual(['*.example.com']);
		expect(policy.maxAge).toBe(604800);
	});

	it('should parse a none policy', () => {
		const text = `version: STSv1
mode: none
max_age: 0`;

		const policy = parseStsPolicy(text, 'v3');
		expect(policy.mode).toBe('none');
		expect(policy.mx).toEqual([]);
	});

	it('should handle multiple MX entries', () => {
		const text = `version: STSv1
mode: enforce
mx: aspmx.l.google.com
mx: alt1.aspmx.l.google.com
mx: alt2.aspmx.l.google.com
mx: *.googlemail.com
max_age: 86400`;

		const policy = parseStsPolicy(text, 'v1');
		expect(policy.mx).toHaveLength(4);
	});

	it('should handle missing max_age (defaults to 86400)', () => {
		const text = `version: STSv1
mode: enforce
mx: *.example.com`;

		const policy = parseStsPolicy(text, 'v1');
		expect(policy.maxAge).toBe(86400);
	});

	it('should ignore blank lines and extra whitespace', () => {
		const text = `version: STSv1

mode: enforce

mx: *.example.com
max_age: 3600`;

		const policy = parseStsPolicy(text, 'v1');
		expect(policy.mode).toBe('enforce');
		expect(policy.mx).toEqual(['*.example.com']);
	});

	it('should default mode to none for unknown values', () => {
		const text = `version: STSv1
mode: invalid
mx: *.example.com
max_age: 86400`;

		const policy = parseStsPolicy(text, 'v1');
		expect(policy.mode).toBe('none');
	});
});

describe('MX hostname validation', () => {
	it('should allow exact hostname match', () => {
		expect(isMxAllowed('mail.google.com', ['mail.google.com'])).toBe(true);
	});

	it('should allow wildcard match', () => {
		expect(isMxAllowed('aspmx.l.google.com', ['*.google.com'])).toBe(true);
	});

	it('should allow nested subdomain match for wildcard (RFC 8461 §4.1)', () => {
		// Per RFC 8461, *.google.com matches any subdomain depth
		expect(isMxAllowed('sub.mail.google.com', ['*.google.com'])).toBe(true);
		expect(isMxAllowed('aspmx.l.google.com', ['*.google.com'])).toBe(true);
	});

	it('should reject hosts not in the pattern list', () => {
		expect(isMxAllowed('evil.attacker.com', ['*.google.com', 'mail.google.com'])).toBe(false);
	});

	it('should be case-insensitive', () => {
		expect(isMxAllowed('MAIL.GOOGLE.COM', ['*.google.com'])).toBe(true);
		expect(isMxAllowed('mail.google.com', ['*.GOOGLE.COM'])).toBe(true);
	});

	it('should handle trailing dots', () => {
		expect(isMxAllowed('mail.google.com.', ['*.google.com'])).toBe(true);
		expect(isMxAllowed('mail.google.com', ['*.google.com.'])).toBe(true);
	});

	it('should allow all hosts when pattern list is empty', () => {
		expect(isMxAllowed('anything.com', [])).toBe(true);
	});

	it('should match from multiple patterns', () => {
		const patterns = ['*.google.com', '*.googlemail.com', 'aspmx.l.google.com'];
		expect(isMxAllowed('alt1.google.com', patterns)).toBe(true);
		expect(isMxAllowed('mail.googlemail.com', patterns)).toBe(true);
		expect(isMxAllowed('aspmx.l.google.com', patterns)).toBe(true);
	});
});
