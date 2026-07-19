/**
 * Unit tests for the shared DMARC SPF-alignment primitives in
 * `../spfAlignment.ts` (PR-68). These back the MTA's envelope-vs-From-domain
 * alignment check and the Convex backend's domain-DNS reasoning.
 */

import { describe, it, expect } from 'vitest';
import { isSpfAligned, emailDomain, organizationalDomain } from '../spfAlignment';

describe('isSpfAligned', () => {
	it('is false for the shared bounce domain vs a customer From-domain', () => {
		expect(isSpfAligned('bounces.owlat.com', 'acme.com', 'relaxed')).toBe(false);
		expect(isSpfAligned('bounces.owlat.com', 'acme.com', 'strict')).toBe(false);
	});

	it('aligns a return-path subdomain under relaxed mode', () => {
		expect(isSpfAligned('bounce.acme.com', 'acme.com', 'relaxed')).toBe(true);
		expect(isSpfAligned('bounce.acme.com', 'news.acme.com', 'relaxed')).toBe(true);
	});

	it('requires identical domains under strict mode', () => {
		expect(isSpfAligned('acme.com', 'acme.com', 'strict')).toBe(true);
		expect(isSpfAligned('bounce.acme.com', 'acme.com', 'strict')).toBe(false);
	});

	it('defaults to relaxed mode', () => {
		expect(isSpfAligned('bounce.acme.com', 'acme.com')).toBe(true);
	});

	it('normalizes case + trailing dot and rejects empties', () => {
		expect(isSpfAligned('ACME.COM.', 'acme.com', 'strict')).toBe(true);
		expect(isSpfAligned('', 'acme.com')).toBe(false);
		expect(isSpfAligned('acme.com', '')).toBe(false);
	});
});

describe('organizationalDomain — Public Suffix List boundaries', () => {
	it('keeps eTLD+1 under a ccTLD second-level suffix so different orgs stay distinct', () => {
		// The bug: `slice(-2)` folded both to `co.uk` → any two .co.uk domains
		// looked aligned. They must now differ.
		expect(organizationalDomain('attacker.co.uk')).toBe('attacker.co.uk');
		expect(organizationalDomain('victim.co.uk')).toBe('victim.co.uk');
		expect(organizationalDomain('attacker.co.uk')).not.toBe(organizationalDomain('victim.co.uk'));
	});

	it('folds a subdomain of a .co.uk org to its registrable domain', () => {
		expect(organizationalDomain('mail.victim.co.uk')).toBe('victim.co.uk');
		expect(organizationalDomain('bounce.victim.co.uk')).toBe('victim.co.uk');
	});

	it('covers the common ccTLD second-level suffixes (com.au, org.uk, co.jp)', () => {
		expect(organizationalDomain('shop.com.au')).toBe('shop.com.au');
		expect(organizationalDomain('charity.org.uk')).toBe('charity.org.uk');
		expect(organizationalDomain('brand.co.jp')).toBe('brand.co.jp');
	});

	it('still distinguishes plain gTLD domains (foo.com vs bar.com)', () => {
		expect(organizationalDomain('foo.com')).toBe('foo.com');
		expect(organizationalDomain('bar.com')).toBe('bar.com');
		expect(organizationalDomain('mail.foo.com')).toBe('foo.com');
		expect(organizationalDomain('foo.com')).not.toBe(organizationalDomain('bar.com'));
	});

	it('closes the co.uk relaxed-alignment bypass: attacker.co.uk is NOT aligned with victim.co.uk', () => {
		// Previously both mapped to `co.uk` and this returned true — a From-spoofing
		// authentication bypass. Now the organizational domains differ.
		expect(isSpfAligned('attacker.co.uk', 'victim.co.uk', 'relaxed')).toBe(false);
		// A genuine subdomain of the same org still aligns.
		expect(isSpfAligned('mail.victim.co.uk', 'victim.co.uk', 'relaxed')).toBe(true);
	});

	it('does not align independent tenants beneath a private multi-label suffix', () => {
		// `uk.com` is a PSL private suffix. A last-two-label heuristic folds both
		// identities to uk.com and lets one registrant authenticate as the other.
		expect(organizationalDomain('attacker.uk.com')).toBe('attacker.uk.com');
		expect(organizationalDomain('victim.uk.com')).toBe('victim.uk.com');
		expect(isSpfAligned('attacker.uk.com', 'victim.uk.com', 'relaxed')).toBe(false);
		expect(isSpfAligned('mail.victim.uk.com', 'victim.uk.com', 'relaxed')).toBe(true);
	});

	it('fails closed to exact matching when no registrable domain exists', () => {
		expect(organizationalDomain('internal')).toBe('internal');
		expect(isSpfAligned('mail.internal', 'internal', 'relaxed')).toBe(false);
	});
});

describe('emailDomain', () => {
	it('extracts the domain from a VERP envelope address', () => {
		expect(emailDomain('bounce+abc123@bounces.owlat.com')).toBe('bounces.owlat.com');
	});

	it('lowercases and returns empty string for malformed input', () => {
		expect(emailDomain('Sender@Acme.COM')).toBe('acme.com');
		expect(emailDomain('no-at-sign')).toBe('');
	});
});
