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

import dns from 'node:dns/promises';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
	tagValueRecordMatches,
	spfRecordMatches,
	txtRecordMatches,
	parseSpfTerms,
} from '../domains/dnsMatch';
import { isDmarcRecord } from '../domains/dmarc';
import { runDnsLookups } from '../domains/dnsVerification';

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
			tagValueRecordMatches('v=DKIM1; k=rsa; t=s; p=AB; s=email', 'v=DKIM1; k=rsa; p=AB')
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
			spfRecordMatches('v=spf1   include:amazonses.com   ~all', 'v=spf1 include:amazonses.com ~all')
		).toBe(true);
	});

	it('is case-insensitive on mechanisms', () => {
		expect(
			spfRecordMatches('V=SPF1 INCLUDE:amazonses.com ~ALL', 'v=spf1 include:amazonses.com ~all')
		).toBe(true);
	});

	it('fails when an expected mechanism is missing', () => {
		expect(
			spfRecordMatches('v=spf1 include:_spf.google.com ~all', 'v=spf1 include:amazonses.com ~all')
		).toBe(false);
	});

	it('is not fooled by a non-SPF record', () => {
		expect(spfRecordMatches('v=DMARC1; p=none', 'v=spf1 include:amazonses.com ~all')).toBe(false);
	});
});

describe('shared tag-list grammar (finding: one grammar for every screen)', () => {
	it('skips empty segments and lower-cases tag names', () => {
		expect(tagValueRecordMatches('V=DKIM1; k=rsa;; p=AB;', 'v=DKIM1; k=rsa; p=AB')).toBe(true);
	});

	it('matches a DKIM key a DNS panel folded with spaces inside p=', () => {
		const expected = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
		const folded = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0B AQEFAAOCAQ8A\tMIIBCgKCAQEA';
		expect(txtRecordMatches(folded, expected)).toBe(true);
		expect(txtRecordMatches(expected, folded)).toBe(true);
	});

	it('resolves a duplicate p= first-wins, like the mail-auth DKIM verifier', () => {
		expect(txtRecordMatches('v=DKIM1; k=rsa; p=AB; p=ZZ', 'v=DKIM1; k=rsa; p=AB')).toBe(true);
		expect(txtRecordMatches('v=DKIM1; k=rsa; p=ZZ; p=AB', 'v=DKIM1; k=rsa; p=AB')).toBe(false);
	});
});

describe('parsers', () => {
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

	it('parseSpfTerms rejects an unknown version string that merely starts with v=spf1', () => {
		expect(parseSpfTerms('v=spf1:broken include:amazonses.com ~all')).toEqual([]);
		expect(
			spfRecordMatches(
				'v=spf1:broken include:amazonses.com ~all',
				'v=spf1 include:amazonses.com ~all'
			)
		).toBe(false);
	});

	it('isDmarcRecord accepts the version tag case-insensitively', () => {
		expect(isDmarcRecord('v=DMARC1; p=none')).toBe(true);
		expect(isDmarcRecord('v=dmarc1; p=none')).toBe(true);
		expect(isDmarcRecord(' v = DMARC1 ;p=none')).toBe(true);
		expect(isDmarcRecord('v=DMARC1')).toBe(true);
		expect(isDmarcRecord('v=DMARC10; p=none')).toBe(false);
		expect(isDmarcRecord('v=spf1 -all')).toBe(false);
	});
});

describe('runDnsLookups "found but wrong" hint', () => {
	afterEach(() => vi.restoreAllMocks());

	const PARTIAL = "Record found but value doesn't match expected configuration";

	it('flags a lowercase v=dmarc1 record at the wrong policy as a partial match', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=dmarc1; p=reject']]);
		const results = await runDnsLookups('example.test', {
			dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
		} as never);
		expect(results.dmarc).toMatchObject({
			verified: false,
			foundValue: 'v=dmarc1; p=reject',
			error: PARTIAL,
		});
	});

	it('does not treat v=spf1:broken as a published SPF record', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=spf1:broken -all']]);
		const results = await runDnsLookups('example.test', {
			spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
		} as never);
		expect(results.spf).toMatchObject({ verified: false, error: 'No matching TXT record found' });
	});

	it('flags a mixed-case SPF record with different mechanisms as a partial match', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['V=SPF1 include:_spf.google.com -all']]);
		const results = await runDnsLookups('example.test', {
			spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
		} as never);
		expect(results.spf).toMatchObject({ verified: false, error: PARTIAL });
	});

	it('verifies a DKIM key published with a folded p=', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=DKIM1; k=rsa; p=MIIBIjAN ', 'BgkqhkiG']]);
		const results = await runDnsLookups('example.test', {
			dkim: [{ type: 'TXT', host: 'sel._domainkey', value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG' }],
		} as never);
		expect(results.dkim).toEqual([expect.objectContaining({ verified: true })]);
	});
});
