import { describe, it, expect } from 'vitest';
import { emailDomain, unverifiedFromDomainWarning } from '../fromEmailDomain';

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

describe('unverifiedFromDomainWarning', () => {
	it('warns when the domain is not among the verified set', () => {
		expect(unverifiedFromDomainWarning('hello@evil.com', ['good.com'])).toBe(
			'evil.com is not a verified sending domain.',
		);
	});

	it('returns null when the domain IS verified (case-insensitive)', () => {
		expect(unverifiedFromDomainWarning('hello@Good.com', ['good.com'])).toBeNull();
		expect(unverifiedFromDomainWarning('hello@good.com', ['GOOD.COM'])).toBeNull();
	});

	it('returns null for an empty or domainless address', () => {
		expect(unverifiedFromDomainWarning('', ['good.com'])).toBeNull();
		expect(unverifiedFromDomainWarning('nope', ['good.com'])).toBeNull();
	});

	it('returns null while the verified set is still loading', () => {
		expect(unverifiedFromDomainWarning('hello@evil.com', undefined)).toBeNull();
		expect(unverifiedFromDomainWarning('hello@evil.com', null)).toBeNull();
	});

	it('warns when there are zero verified domains', () => {
		expect(unverifiedFromDomainWarning('hello@evil.com', [])).toBe(
			'evil.com is not a verified sending domain.',
		);
	});
});
