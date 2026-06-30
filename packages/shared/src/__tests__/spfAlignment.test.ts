/**
 * Unit tests for the shared DMARC SPF-alignment primitives in
 * `../spfAlignment.ts` (PR-68). These back the MTA's envelope-vs-From-domain
 * alignment check and the Convex backend's domain-DNS reasoning.
 */

import { describe, it, expect } from 'vitest';
import { isSpfAligned, emailDomain } from '../spfAlignment';

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

describe('emailDomain', () => {
	it('extracts the domain from a VERP envelope address', () => {
		expect(emailDomain('bounce+abc123@bounces.owlat.com')).toBe('bounces.owlat.com');
	});

	it('lowercases and returns empty string for malformed input', () => {
		expect(emailDomain('Sender@Acme.COM')).toBe('acme.com');
		expect(emailDomain('no-at-sign')).toBe('');
	});
});
