/**
 * Unit tests for the shared zone / Public-Suffix-List foundation in
 * `../dnsZone.ts` (piece A1 of the DNS setup revamp). These back the DNS record
 * panel's zone-relative host display, the Add-Domain picker's parse/preview, and
 * the Convex verifier's registrable-zone reasoning, so the failure paths matter
 * as much as the happy ones.
 */

import { describe, it, expect } from 'vitest';
import {
	asDnsName,
	isDnsLabel,
	splitZone,
	trySplitZone,
	zoneRelativeHost,
	InvalidDomainError,
	type DnsName,
	type ZoneSplit,
} from '../dnsZone';

/** Build an expected ZoneSplit; `sub` is derived so the tests stay honest about it. */
const zone = (registrable: string, subLabels: string[] = []): ZoneSplit => ({
	registrable: registrable as DnsName,
	subLabels,
	sub: subLabels.join('.'),
});

describe('splitZone', () => {
	it('splits an apex domain into an empty sub', () => {
		expect(splitZone('example.com')).toEqual(zone('example.com'));
	});

	it('splits a single sending subdomain', () => {
		expect(splitZone('mail.example.com')).toEqual(zone('example.com', ['mail']));
	});

	it('splits a deep subdomain, preserving FQDN label order', () => {
		expect(splitZone('s171._domainkey.mail.example.com')).toEqual(
			zone('example.com', ['s171', '_domainkey', 'mail'])
		);
	});

	it('treats a multi-label public suffix (co.uk) as part of the zone', () => {
		expect(splitZone('example.co.uk')).toEqual(zone('example.co.uk'));
		expect(splitZone('mail.example.co.uk')).toEqual(zone('example.co.uk', ['mail']));
		expect(splitZone('a.b.example.co.uk')).toEqual(zone('example.co.uk', ['a', 'b']));
	});

	it('handles other multi-label suffixes (gov.au, pvt.k12.ma.us)', () => {
		expect(splitZone('mail.dept.gov.au').registrable).toBe('dept.gov.au');
		// A deep US school-district suffix — the kind a "last two labels" rule ruins.
		expect(splitZone('host.school.pvt.k12.ma.us').registrable).toBe('school.pvt.k12.ma.us');
	});

	it('splits at the ICANN suffix, not a PSL private entry', () => {
		// blogspot.com is a PSL *private* suffix; the registrable zone the user
		// controls is still blogspot.com under the ICANN `.com`.
		expect(splitZone('foo.blogspot.com').registrable).toBe('blogspot.com');
	});

	it('normalizes case and a trailing (absolute) dot', () => {
		expect(splitZone('MAIL.Example.COM.')).toEqual(zone('example.com', ['mail']));
	});

	it('IDNA-encodes Unicode input to punycode', () => {
		// münchen.de
		expect(splitZone('münchen.de')).toEqual(zone('xn--mnchen-3ya.de'));
		expect(splitZone('mail.münchen.de')).toEqual(zone('xn--mnchen-3ya.de', ['mail']));
	});

	it('accepts an already-punycode domain unchanged', () => {
		// example.рф (Russian IDN ccTLD, itself a punycode public suffix).
		expect(splitZone('example.xn--p1ai').registrable).toBe('example.xn--p1ai');
		expect(splitZone('xn--mnchen-3ya.de').registrable).toBe('xn--mnchen-3ya.de');
	});

	it('throws InvalidDomainError on inputs with no registrable domain', () => {
		for (const bad of [
			'', // empty
			'   ', // whitespace only
			'localhost', // single label
			'co.uk', // bare public suffix
			'com', // bare TLD
			'127.0.0.1', // IPv4 literal
			'mail example.com', // space
			'a//b.com', // path characters
			'user@example.com', // an email address, not a domain
			'a..b.com', // empty label
			'-bad.example.com', // leading-hyphen label
		]) {
			expect(() => splitZone(bad), `expected "${bad}" to throw`).toThrow(InvalidDomainError);
		}
	});

	it('exposes the offending input on the thrown error', () => {
		try {
			splitZone('co.uk');
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidDomainError);
			expect((err as InvalidDomainError).input).toBe('co.uk');
		}
	});
});

describe('trySplitZone', () => {
	it('returns the split for valid input', () => {
		expect(trySplitZone('mail.example.com')?.registrable).toBe('example.com');
	});

	it('returns null instead of throwing for invalid input', () => {
		expect(trySplitZone('co.uk')).toBeNull();
		expect(trySplitZone('localhost')).toBeNull();
		expect(trySplitZone('')).toBeNull();
		expect(trySplitZone('1.2.3.4')).toBeNull();
	});
});

describe('zoneRelativeHost', () => {
	it('renders a DKIM host relative to the registrable zone', () => {
		expect(zoneRelativeHost('s171._domainkey.mail.example.com', 'mail.example.com')).toBe(
			's171._domainkey.mail'
		);
	});

	it('renders _dmarc / _smtp._tls / _mta-sts relative to the zone', () => {
		expect(zoneRelativeHost('_dmarc.example.com', 'example.com')).toBe('_dmarc');
		expect(zoneRelativeHost('_smtp._tls.mail.example.com', 'mail.example.com')).toBe(
			'_smtp._tls.mail'
		);
		expect(zoneRelativeHost('_mta-sts.example.com', 'example.com')).toBe('_mta-sts');
	});

	it('returns "@" when the host is the zone apex', () => {
		expect(zoneRelativeHost('example.com', 'example.com')).toBe('@');
		// Sending domain is a subdomain but the record sits at the registrable apex.
		expect(zoneRelativeHost('example.com', 'mail.example.com')).toBe('@');
	});

	it('is correct across a multi-label public suffix', () => {
		expect(zoneRelativeHost('s1._domainkey.example.co.uk', 'example.co.uk')).toBe('s1._domainkey');
		expect(zoneRelativeHost('example.co.uk', 'example.co.uk')).toBe('@');
	});

	it('normalizes case / trailing dot / IDN on both arguments', () => {
		expect(zoneRelativeHost('_DMARC.Mail.Example.COM.', 'MAIL.example.com')).toBe('_dmarc.mail');
		expect(zoneRelativeHost('mail.münchen.de', 'münchen.de')).toBe('mail');
	});

	it('returns an absolute (trailing-dot) name for an out-of-zone host', () => {
		// A shared return-path host under a different registrable domain than the
		// customer's sending domain — cannot be made relative to example.com.
		expect(zoneRelativeHost('bounces.owlat.com', 'example.com')).toBe('bounces.owlat.com.');
		// Same registrable label sequence but a *different* zone must not partial-match.
		expect(zoneRelativeHost('notexample.com', 'example.com')).toBe('notexample.com.');
	});

	it('does not treat a suffix that only string-matches as in-zone', () => {
		// "myexample.com" ends with "example.com" as a substring but not as a zone.
		expect(zoneRelativeHost('a.myexample.com', 'example.com')).toBe('a.myexample.com.');
	});

	it('throws InvalidDomainError when the sending domain has no zone', () => {
		expect(() => zoneRelativeHost('_dmarc.localhost', 'localhost')).toThrow(InvalidDomainError);
	});

	it('throws InvalidDomainError when the record host is not a valid DNS name', () => {
		expect(() => zoneRelativeHost('not a host', 'example.com')).toThrow(InvalidDomainError);
	});
});

describe('isDnsLabel', () => {
	it('accepts ordinary hostname labels', () => {
		for (const ok of ['mail', 'post', 'send', 'a', 'x1', 'my-domain', 'xn--mnchen-3ya']) {
			expect(isDnsLabel(ok), ok).toBe(true);
		}
	});

	it('accepts a 63-character label and rejects a 64-character one', () => {
		expect(isDnsLabel('a'.repeat(63))).toBe(true);
		expect(isDnsLabel('a'.repeat(64))).toBe(false);
	});

	it('rejects empty, hyphen-edge, and dotted input', () => {
		expect(isDnsLabel('')).toBe(false);
		expect(isDnsLabel('-lead')).toBe(false);
		expect(isDnsLabel('trail-')).toBe(false);
		expect(isDnsLabel('has.dot')).toBe(false);
	});

	it('rejects underscore and other non-LDH characters (strict hostname rule)', () => {
		// Underscore is valid in a *service* label but never in a user-chosen
		// sending subdomain, which is what this validator guards.
		expect(isDnsLabel('_dmarc')).toBe(false);
		expect(isDnsLabel('under_score')).toBe(false);
		expect(isDnsLabel('spa ce')).toBe(false);
		expect(isDnsLabel('sla/sh')).toBe(false);
		expect(isDnsLabel('münchen')).toBe(false);
	});
});

describe('asDnsName', () => {
	it('normalizes to lowercase punycode without a trailing dot', () => {
		expect(asDnsName('Mail.Example.COM.')).toBe('mail.example.com');
		expect(asDnsName('münchen.de')).toBe('xn--mnchen-3ya.de');
	});

	it('keeps underscore service labels (they are valid wire labels)', () => {
		expect(asDnsName('_dmarc.example.com')).toBe('_dmarc.example.com');
	});

	it('returns null for malformed input', () => {
		for (const bad of [
			'',
			'   ',
			'a..b.com',
			'has space.com',
			'a/b.com',
			'x@y.com',
			'a.com:8080',
		]) {
			expect(asDnsName(bad), bad).toBeNull();
		}
	});
});
