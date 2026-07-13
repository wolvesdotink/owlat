/**
 * ARC trust predicate + trusted-forwarder validation (Sealed Mail A5).
 *
 * These pure predicates are the shared floor both the MTA and the Convex
 * delivery path rely on. The security-critical property is that a bare,
 * single-label allow-list entry can NEVER act as a TLD wildcard, and that the
 * server-side sanitizer drops exactly the entries the UI editor would reject —
 * so a direct `settings.update` can't widen who we trust.
 */

import { describe, it, expect } from 'vitest';
import {
	isTrustedForwarder,
	isValidForwarderDomain,
	normalizeDomain,
	sanitizeTrustedForwarders,
	shouldArcOverrideDmarc,
} from '../arcTrust';

describe('normalizeDomain', () => {
	it('lowercases, trims, and strips a single trailing dot', () => {
		expect(normalizeDomain('  Google.COM.  ')).toBe('google.com');
		expect(normalizeDomain(undefined)).toBe('');
	});
});

describe('isTrustedForwarder — single-label entries are never wildcards', () => {
	it('does not trust a sealer under a bare single-label entry', () => {
		expect(isTrustedForwarder('spammer.com', ['com'])).toBe(false);
		expect(isTrustedForwarder('mail.spammer.com', ['com'])).toBe(false);
	});

	it('still matches exact and subdomain of a dot-bearing entry', () => {
		expect(isTrustedForwarder('acme.com', ['acme.com'])).toBe(true);
		expect(isTrustedForwarder('mail-a.acme.com', ['acme.com'])).toBe(true);
		expect(isTrustedForwarder('acme.com.evil.example', ['acme.com'])).toBe(false);
	});

	it('an empty or absent sealer never matches', () => {
		expect(isTrustedForwarder(undefined, ['acme.com'])).toBe(false);
		expect(isTrustedForwarder('', ['acme.com'])).toBe(false);
	});
});

describe('isValidForwarderDomain', () => {
	it('accepts a bare dot-bearing hostname', () => {
		expect(isValidForwarderDomain('lists.example.org')).toBe(true);
	});

	it('rejects single-label, blank, and whitespace-bearing entries', () => {
		expect(isValidForwarderDomain('com')).toBe(false);
		expect(isValidForwarderDomain('')).toBe(false);
		expect(isValidForwarderDomain('  ')).toBe(false);
		expect(isValidForwarderDomain('a b.com')).toBe(false);
		expect(isValidForwarderDomain(undefined)).toBe(false);
	});
});

describe('sanitizeTrustedForwarders', () => {
	it('normalizes, drops invalid entries, and de-duplicates', () => {
		expect(
			sanitizeTrustedForwarders([
				'  Google.com. ',
				'com', // single-label — dropped
				'google.com', // duplicate after normalize
				'', // blank — dropped
				'a b.com', // whitespace — dropped
				'groups.google.com',
			])
		).toEqual(['google.com', 'groups.google.com']);
	});

	it('returns an empty list for an all-invalid input (rescue stays off)', () => {
		expect(sanitizeTrustedForwarders(['com', 'org', ''])).toEqual([]);
	});
});

describe('shouldArcOverrideDmarc — end-to-end gate with a wildcard-attempt list', () => {
	it('does not rescue a sealer under a single-label allow-list entry', () => {
		expect(
			shouldArcOverrideDmarc(
				{ arcCv: 'pass', arcSealerDomain: 'evil.com', arcAttestsOriginalPass: true },
				['com']
			)
		).toBe(false);
	});
});
