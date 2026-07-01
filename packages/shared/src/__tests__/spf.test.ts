import { describe, it, expect } from 'vitest';
import { isSpfRecord, parseSpfMechanisms, mergeSpfRecords } from '../spf';

describe('isSpfRecord', () => {
	it('recognises an SPF record, case-insensitively and with leading whitespace', () => {
		expect(isSpfRecord('v=spf1 -all')).toBe(true);
		expect(isSpfRecord('  V=SPF1 include:_spf.google.com ~all')).toBe(true);
	});

	it('rejects non-SPF TXT values', () => {
		expect(isSpfRecord('v=DMARC1; p=none')).toBe(false);
		expect(isSpfRecord('google-site-verification=abc')).toBe(false);
		expect(isSpfRecord('')).toBe(false);
	});
});

describe('parseSpfMechanisms', () => {
	it('returns mechanisms after v=spf1, excluding the trailing all', () => {
		expect(parseSpfMechanisms('v=spf1 include:_spf.google.com ip4:203.0.113.10 ~all')).toEqual([
			'include:_spf.google.com',
			'ip4:203.0.113.10',
		]);
	});

	it('handles a:/mx mechanisms and a hard-fail qualifier', () => {
		expect(parseSpfMechanisms('v=spf1 a:mail.example.com mx -all')).toEqual([
			'a:mail.example.com',
			'mx',
		]);
	});

	it('returns [] for a record with only a version + all', () => {
		expect(parseSpfMechanisms('v=spf1 -all')).toEqual([]);
	});
});

describe('mergeSpfRecords', () => {
	it('inserts a foreign SES include before the existing Google record trailing all', () => {
		expect(
			mergeSpfRecords('v=spf1 include:_spf.google.com ~all', 'v=spf1 include:amazonses.com ~all'),
		).toBe('v=spf1 include:_spf.google.com include:amazonses.com ~all');
	});

	it('is idempotent when ours mechanisms are already present', () => {
		const existing = 'v=spf1 include:_spf.google.com include:amazonses.com ~all';
		expect(mergeSpfRecords(existing, 'v=spf1 include:amazonses.com ~all')).toBe(existing);
	});

	it('merges mixed a:/ip4:/include: mechanisms', () => {
		expect(
			mergeSpfRecords(
				'v=spf1 ip4:198.51.100.5 -all',
				'v=spf1 a:mail.example.com ip4:203.0.113.10 include:amazonses.com -all',
			),
		).toBe(
			'v=spf1 ip4:198.51.100.5 a:mail.example.com ip4:203.0.113.10 include:amazonses.com -all',
		);
	});

	it("preserves the existing record's trailing qualifier (hard-fail stays -all)", () => {
		const merged = mergeSpfRecords('v=spf1 include:_spf.google.com -all', 'v=spf1 a:mail.example.com ~all');
		expect(merged).toBe('v=spf1 include:_spf.google.com a:mail.example.com -all');
		expect(merged.endsWith(' -all')).toBe(true);
	});

	it('appends when the existing record has no all mechanism', () => {
		expect(mergeSpfRecords('v=spf1 ip4:198.51.100.5', 'v=spf1 include:amazonses.com')).toBe(
			'v=spf1 ip4:198.51.100.5 include:amazonses.com',
		);
	});

	it('compares mechanisms case-insensitively (no duplicate for a cased match)', () => {
		expect(
			mergeSpfRecords('v=spf1 INCLUDE:amazonses.com ~all', 'v=spf1 include:amazonses.com ~all'),
		).toBe('v=spf1 INCLUDE:amazonses.com ~all');
	});
});
