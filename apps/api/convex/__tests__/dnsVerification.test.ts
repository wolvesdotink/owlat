/**
 * Unit tests for the tag/mechanism-aware TXT matchers in `domains/dnsMatch.ts`,
 * which back the DNS verifier (`domains/dnsVerification.ts`).
 *
 * Regression for PR-67: the verifier used to compare published records with a
 * raw `=== / .includes()`, so a DKIM record returned without the surrounding
 * whitespace falsely failed, and a valid SPF record carrying an extra
 * `include:` mechanism was marked not-verified. These match the way the RFCs
 * define equality instead (RFC 6376 §3.6.1, RFC 7489 §6.3, RFC 7208 §3.2).
 */

import { describe, it, expect } from 'vitest';
import {
	tagValueRecordMatches,
	spfRecordMatches,
	txtRecordMatches,
	parseTagValueRecord,
	parseSpfTerms,
} from '../domains/dnsMatch';

describe('tagValueRecordMatches (DKIM / DMARC)', () => {
	it('matches a whitespace-normalised DKIM record against the spaced expected value', () => {
		// Published with NO spaces around the separators; expected has them.
		expect(tagValueRecordMatches('v=DKIM1;k=rsa;p=AB', 'v=DKIM1; k=rsa; p=AB')).toBe(true);
		// ...and the reverse direction.
		expect(txtRecordMatches('v=DKIM1;k=rsa;p=AB', 'v=DKIM1; k=rsa; p=AB')).toBe(true);
	});

	it('tolerates extra tags on the published record', () => {
		// Real DKIM records often add t=, s=, etc.
		expect(
			tagValueRecordMatches('v=DKIM1; k=rsa; t=s; p=AB; s=email', 'v=DKIM1; k=rsa; p=AB'),
		).toBe(true);
	});

	it('is order- and case-insensitive on tag names', () => {
		expect(tagValueRecordMatches('p=AB; K=rsa; V=DKIM1', 'v=DKIM1; k=rsa; p=AB')).toBe(true);
	});

	it('still rejects a genuinely different value', () => {
		expect(tagValueRecordMatches('v=DKIM1; k=rsa; p=ZZ', 'v=DKIM1; k=rsa; p=AB')).toBe(false);
		expect(tagValueRecordMatches('v=DKIM1; k=rsa', 'v=DKIM1; k=rsa; p=AB')).toBe(false);
	});

	it('matches a DMARC record regardless of inter-tag whitespace', () => {
		expect(txtRecordMatches('v=DMARC1;p=none', 'v=DMARC1; p=none')).toBe(true);
		expect(txtRecordMatches('v=DMARC1;  p=none', 'v=DMARC1; p=none')).toBe(true);
	});

	it('rejects a DMARC record at a different policy', () => {
		expect(txtRecordMatches('v=DMARC1; p=reject', 'v=DMARC1; p=none')).toBe(false);
	});
});

describe('spfRecordMatches', () => {
	it('recognises a valid multi-mechanism SPF record that adds an include:', () => {
		// Published adds `include:_spf.google.com`; we only asked for amazonses.
		const published = 'v=spf1 include:_spf.google.com include:amazonses.com ~all';
		const expected = 'v=spf1 include:amazonses.com ~all';
		expect(spfRecordMatches(published, expected)).toBe(true);
		// And the high-level entry point routes SPF to the mechanism matcher.
		expect(txtRecordMatches(published, expected)).toBe(true);
	});

	it('matches despite extra whitespace between mechanisms', () => {
		expect(
			spfRecordMatches('v=spf1   include:amazonses.com   ~all', 'v=spf1 include:amazonses.com ~all'),
		).toBe(true);
	});

	it('is case-insensitive on mechanisms', () => {
		expect(
			spfRecordMatches('V=SPF1 INCLUDE:amazonses.com ~ALL', 'v=spf1 include:amazonses.com ~all'),
		).toBe(true);
	});

	it('fails when an expected mechanism is missing', () => {
		expect(
			spfRecordMatches('v=spf1 include:_spf.google.com ~all', 'v=spf1 include:amazonses.com ~all'),
		).toBe(false);
	});

	it('is not fooled by a non-SPF record', () => {
		expect(spfRecordMatches('v=DMARC1; p=none', 'v=spf1 include:amazonses.com ~all')).toBe(false);
	});
});

describe('parsers', () => {
	it('parseTagValueRecord skips empty segments and lower-cases tags', () => {
		const map = parseTagValueRecord('V=DKIM1; k=rsa;; p=AB;');
		expect(map.get('v')).toBe('DKIM1');
		expect(map.get('k')).toBe('rsa');
		expect(map.get('p')).toBe('AB');
		expect(map.size).toBe(3);
	});

	it('parseSpfTerms returns the lower-cased terms of an SPF record', () => {
		expect(parseSpfTerms('v=spf1 include:amazonses.com ~all')).toEqual([
			'v=spf1',
			'include:amazonses.com',
			'~all',
		]);
	});

	it('parseSpfTerms returns [] for a non-SPF record', () => {
		expect(parseSpfTerms('v=DMARC1; p=none')).toEqual([]);
	});
});
