/**
 * Unit tests for the pure SPF helpers in `domains/spf.ts`.
 * No Convex setup — these are pure functions.
 *
 * Covers PR-68:
 *  - SPF_QUALIFIER option (default `~all`, `-all` once the IP set is stable).
 *  - Duplicate / existing-record detection (a 2nd v=spf1 at an apex = PermError).
 *  - DMARC SPF alignment (return-path domain vs From-domain).
 *  - The return-path SPF record an operator must publish on RETURN_PATH_DOMAIN.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_SPF_QUALIFIER,
	buildReturnPathSpfRecord,
	buildSpfRecordValue,
	countSpfRecords,
	detectMultipleSpf,
	emailDomain,
	insertIncludeIntoExisting,
	isSpfAligned,
	isSpfQualifier,
	mergeSpfIncludeGuidance,
	resolveSpfQualifier,
} from '../domains/spf';

describe('buildSpfRecordValue', () => {
	it('defaults the trailing mechanism to the soft-fail ~all', () => {
		expect(buildSpfRecordValue({ include: '_spf.owlat.example' })).toBe(
			'v=spf1 include:_spf.owlat.example ~all',
		);
		expect(DEFAULT_SPF_QUALIFIER).toBe('~all');
	});

	it('emits -all when the operator sets the hard-fail qualifier', () => {
		const value = buildSpfRecordValue({ include: '_spf.owlat.example', qualifier: '-all' });
		expect(value).toBe('v=spf1 include:_spf.owlat.example -all');
		expect(value.endsWith(' -all')).toBe(true);
	});

	it('emits ip4 mechanisms before include, then the all mechanism', () => {
		expect(
			buildSpfRecordValue({
				ip4: ['203.0.113.10', '203.0.113.11'],
				include: '_spf.owlat.example',
				qualifier: '-all',
			}),
		).toBe('v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 include:_spf.owlat.example -all');
	});

	it('skips blank ip4 entries and an empty include', () => {
		expect(buildSpfRecordValue({ ip4: ['203.0.113.10', '', '  '], include: '   ' })).toBe(
			'v=spf1 ip4:203.0.113.10 ~all',
		);
	});
});

describe('resolveSpfQualifier / isSpfQualifier', () => {
	it('accepts the four valid qualifiers', () => {
		expect(isSpfQualifier('~all')).toBe(true);
		expect(isSpfQualifier('-all')).toBe(true);
		expect(isSpfQualifier('?all')).toBe(true);
		expect(isSpfQualifier('+all')).toBe(true);
	});

	it('rejects anything else', () => {
		expect(isSpfQualifier('all')).toBe(false);
		expect(isSpfQualifier('-none')).toBe(false);
		expect(isSpfQualifier(undefined)).toBe(false);
		expect(isSpfQualifier(null)).toBe(false);
	});

	it('falls back to the soft-fail default for unset/invalid input', () => {
		expect(resolveSpfQualifier(undefined)).toBe('~all');
		expect(resolveSpfQualifier('')).toBe('~all');
		expect(resolveSpfQualifier('garbage')).toBe('~all');
		expect(resolveSpfQualifier('  -all  ')).toBe('-all');
	});
});

describe('buildReturnPathSpfRecord', () => {
	it('authorizes each pool IP and soft-fails by default', () => {
		expect(buildReturnPathSpfRecord(['203.0.113.10', '203.0.113.11'])).toBe(
			'v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 ~all',
		);
	});

	it('hard-fails when the qualifier is -all', () => {
		expect(buildReturnPathSpfRecord(['203.0.113.10'], '-all')).toBe('v=spf1 ip4:203.0.113.10 -all');
	});
});

describe('detectMultipleSpf / countSpfRecords', () => {
	it('counts only v=spf1 records (case-insensitive, leading whitespace ok)', () => {
		expect(
			countSpfRecords([
				'v=spf1 ip4:203.0.113.10 -all',
				'  V=SPF1 include:other -all',
				'google-site-verification=abc',
			]),
		).toBe(2);
	});

	it('flags a host that already publishes more than one SPF record', () => {
		expect(
			detectMultipleSpf(['v=spf1 ip4:203.0.113.10 -all', 'v=spf1 include:_spf.google.com ~all']),
		).toBe(true);
	});

	it('does not flag a single SPF record (with unrelated TXT records present)', () => {
		expect(
			detectMultipleSpf(['v=spf1 ip4:203.0.113.10 -all', 'google-site-verification=abc']),
		).toBe(false);
		expect(detectMultipleSpf([])).toBe(false);
	});
});

describe('mergeSpfIncludeGuidance / insertIncludeIntoExisting', () => {
	it('returns merge guidance when an SPF record already exists', () => {
		const guidance = mergeSpfIncludeGuidance(
			['v=spf1 ip4:198.51.100.5 -all'],
			'_spf.owlat.example',
		);
		expect(guidance).toMatch(/merge include into existing record/i);
		expect(guidance).toContain('include:_spf.owlat.example');
		expect(guidance).toContain('v=spf1 ip4:198.51.100.5 include:_spf.owlat.example -all');
	});

	it('returns null when there is no existing SPF record (safe to publish)', () => {
		expect(mergeSpfIncludeGuidance(['google-site-verification=abc'], '_spf.owlat.example')).toBe(
			null,
		);
		expect(mergeSpfIncludeGuidance([], '_spf.owlat.example')).toBe(null);
	});

	it('splices include before the trailing all mechanism', () => {
		expect(insertIncludeIntoExisting('v=spf1 ip4:198.51.100.5 -all', '_spf.x')).toBe(
			'v=spf1 ip4:198.51.100.5 include:_spf.x -all',
		);
	});

	it('appends include when there is no all mechanism', () => {
		expect(insertIncludeIntoExisting('v=spf1 ip4:198.51.100.5', '_spf.x')).toBe(
			'v=spf1 ip4:198.51.100.5 include:_spf.x',
		);
	});
});

describe('isSpfAligned', () => {
	it('is false when the return-path domain differs from the From-domain (today)', () => {
		// The MTA's shared bounce domain does NOT align with a customer From-domain.
		expect(isSpfAligned('bounces.owlat.com', 'acme.com', 'relaxed')).toBe(false);
		expect(isSpfAligned('bounces.owlat.com', 'acme.com', 'strict')).toBe(false);
	});

	it('is true under relaxed mode for a return-path subdomain of the From-domain', () => {
		// Per-customer return-path subdomain shares the organizational domain.
		expect(isSpfAligned('bounce.acme.com', 'acme.com', 'relaxed')).toBe(true);
		expect(isSpfAligned('bounce.acme.com', 'mail.acme.com', 'relaxed')).toBe(true);
	});

	it('requires identical domains under strict mode', () => {
		expect(isSpfAligned('acme.com', 'acme.com', 'strict')).toBe(true);
		expect(isSpfAligned('bounce.acme.com', 'acme.com', 'strict')).toBe(false);
	});

	it('normalizes case and trailing dots, and rejects empty domains', () => {
		expect(isSpfAligned('ACME.COM.', 'acme.com', 'strict')).toBe(true);
		expect(isSpfAligned('', 'acme.com')).toBe(false);
		expect(isSpfAligned('acme.com', '')).toBe(false);
	});
});

describe('emailDomain', () => {
	it('extracts the domain from a VERP/plus-addressed envelope address', () => {
		expect(emailDomain('bounce+abc123@bounces.owlat.com')).toBe('bounces.owlat.com');
		expect(emailDomain('sender@Acme.COM')).toBe('acme.com');
	});

	it('returns empty string for a malformed address', () => {
		expect(emailDomain('no-at-sign')).toBe('');
	});
});
