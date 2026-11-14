import { describe, it, expect } from 'vitest';
import { emailDomain, unverifiedFromDomain } from '../fromEmailDomain';

describe('emailDomain', () => {
	it('extracts and lowercases the domain', () => {
		expect(emailDomain('Hello@Example.COM')).toBe('example.com');
	});

	it('uses the last @ for addresses with quoted local parts', () => {
		expect(emailDomain('"a@b"@example.com')).toBe('example.com');
	});

	it('returns null when there is no domain part', () => {
		expect(emailDomain('not-an-email')).toBeNull();
		expect(emailDomain('trailing@')).toBeNull();
		expect(emailDomain('')).toBeNull();
	});
});

describe('unverifiedFromDomain', () => {
	it('names the domain when it is not among the verified set', () => {
		expect(unverifiedFromDomain('hello@evil.com', ['good.com'])).toBe('evil.com');
	});

	it('returns null when the domain IS verified (case-insensitive)', () => {
		expect(unverifiedFromDomain('hello@Good.com', ['good.com'])).toBeNull();
		expect(unverifiedFromDomain('hello@good.com', ['GOOD.COM'])).toBeNull();
	});

	it('returns null for an empty or domainless address', () => {
		expect(unverifiedFromDomain('', ['good.com'])).toBeNull();
		expect(unverifiedFromDomain('nope', ['good.com'])).toBeNull();
	});

	it('returns null while the verified set is still loading', () => {
		expect(unverifiedFromDomain('hello@evil.com', undefined)).toBeNull();
		expect(unverifiedFromDomain('hello@evil.com', null)).toBeNull();
	});

	it('names the domain when there are zero verified domains', () => {
		expect(unverifiedFromDomain('hello@evil.com', [])).toBe('evil.com');
	});
});
