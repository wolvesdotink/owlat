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
	dmarcRecordMatches,
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

	it('rejects a DMARC record at a weaker policy than the one we generated', () => {
		expect(txtRecordMatches('v=DMARC1; p=none', 'v=DMARC1; p=reject')).toBe(false);
		expect(txtRecordMatches('v=DMARC1; p=quarantine', 'v=DMARC1; p=reject')).toBe(false);
	});
});

describe('dmarcRecordMatches', () => {
	it.each(['quarantine', 'reject', 'REJECT'])(
		'accepts a published p=%s against a generated p=none',
		(policy) => {
			expect(dmarcRecordMatches(`v=DMARC1; p=${policy}`, 'v=DMARC1; p=none')).toBe(true);
			expect(txtRecordMatches(`v=DMARC1; p=${policy}`, 'v=DMARC1; p=none')).toBe(true);
		}
	);

	it('accepts p=reject against a generated p=quarantine', () => {
		expect(dmarcRecordMatches('v=DMARC1; p=reject', 'v=DMARC1; p=quarantine')).toBe(true);
	});

	it('rejects a record with no policy or an unknown one', () => {
		expect(dmarcRecordMatches('v=DMARC1; rua=mailto:a@example.test', 'v=DMARC1; p=none')).toBe(
			false
		);
		expect(dmarcRecordMatches('v=DMARC1; p=strict', 'v=DMARC1; p=none')).toBe(false);
	});

	it('judges a generated sp= against the published sp=, defaulting to p=', () => {
		const expected = 'v=DMARC1; p=none; sp=quarantine';
		expect(dmarcRecordMatches('v=DMARC1; p=none; sp=reject', expected)).toBe(true);
		expect(dmarcRecordMatches('v=DMARC1; p=reject', expected)).toBe(true);
		expect(dmarcRecordMatches('v=DMARC1; p=none', expected)).toBe(false);
		expect(dmarcRecordMatches('v=DMARC1; p=reject; sp=none', expected)).toBe(false);
	});

	it('holds an omitted sp= and pct= to their defaults', () => {
		expect(dmarcRecordMatches('v=DMARC1; p=reject; sp=none', 'v=DMARC1; p=reject')).toBe(false);
		expect(dmarcRecordMatches('v=DMARC1; p=reject; pct=0', 'v=DMARC1; p=reject')).toBe(false);
		expect(dmarcRecordMatches('v=DMARC1; p=reject; sp=reject; pct=100', 'v=DMARC1; p=reject')).toBe(
			true
		);
		expect(dmarcRecordMatches('v=DMARC1; p=none; sp=quarantine', 'v=DMARC1; p=none')).toBe(true);
	});

	it('accepts a rua= list that contains our address next to other recipients', () => {
		const expected = 'v=DMARC1; p=none; rua=mailto:dmarc-reports@bounce.example.test';
		expect(
			dmarcRecordMatches(
				'v=DMARC1; p=none; rua=mailto:reports@vendor.test,mailto:DMARC-Reports@bounce.example.test!10m',
				expected
			)
		).toBe(true);
		expect(dmarcRecordMatches('v=DMARC1; p=none; rua=mailto:reports@vendor.test', expected)).toBe(
			false
		);
		expect(dmarcRecordMatches('v=DMARC1; p=none', expected)).toBe(false);
	});

	it('requires every generated rua= recipient', () => {
		const expected = 'v=DMARC1; p=none; rua=mailto:a@example.test,mailto:b@example.test';
		expect(
			dmarcRecordMatches(
				'v=DMARC1; p=none; rua=mailto:b@example.test,mailto:a@example.test',
				expected
			)
		).toBe(true);
		expect(dmarcRecordMatches('v=DMARC1; p=none; rua=mailto:a@example.test', expected)).toBe(false);
	});

	it('accepts a stricter pct= and alignment, defaulting to pct=100 and relaxed', () => {
		expect(dmarcRecordMatches('v=DMARC1; p=reject', 'v=DMARC1; p=reject; pct=25')).toBe(true);
		expect(dmarcRecordMatches('v=DMARC1; p=reject; pct=10', 'v=DMARC1; p=reject; pct=25')).toBe(
			false
		);
		expect(dmarcRecordMatches('v=DMARC1; p=none', 'v=DMARC1; p=none; adkim=r; aspf=r')).toBe(true);
		expect(
			dmarcRecordMatches('v=DMARC1; p=none; adkim=s; aspf=s', 'v=DMARC1; p=none; adkim=r; aspf=r')
		).toBe(true);
		expect(dmarcRecordMatches('v=DMARC1; p=none; adkim=r', 'v=DMARC1; p=none; adkim=s')).toBe(
			false
		);
	});

	it('is not fooled by a non-DMARC record', () => {
		expect(dmarcRecordMatches('v=spf1 -all', 'v=DMARC1; p=none')).toBe(false);
		expect(dmarcRecordMatches('v=DMARC2; p=reject', 'v=DMARC1; p=none')).toBe(false);
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

	it('accepts a published -all against a generated ~all', () => {
		expect(
			spfRecordMatches('v=spf1 include:amazonses.com -all', 'v=spf1 include:amazonses.com ~all')
		).toBe(true);
		expect(
			txtRecordMatches(
				'v=spf1 include:_spf.google.com include:amazonses.com -all',
				'v=spf1 include:amazonses.com ~all'
			)
		).toBe(true);
	});

	it('requires -all when the generated record ends in -all', () => {
		const expected = 'v=spf1 ip4:203.0.113.10 -all';
		expect(spfRecordMatches('v=spf1 ip4:203.0.113.10 -all', expected)).toBe(true);
		expect(spfRecordMatches('v=spf1 ip4:203.0.113.10 ~all', expected)).toBe(false);
	});

	it.each([
		'v=spf1 include:amazonses.com +all',
		'v=spf1 include:amazonses.com all',
		'v=spf1 include:amazonses.com ?all',
		'v=spf1 +all include:amazonses.com ~all',
		'v=spf1 ?all include:amazonses.com -all',
	])('never verifies a record that lets everyone pass or stay neutral: %s', (published) => {
		expect(spfRecordMatches(published, 'v=spf1 include:amazonses.com ~all')).toBe(false);
		expect(spfRecordMatches(published, 'v=spf1 include:amazonses.com ?all')).toBe(false);
	});

	it('fails when the record has no terminal all at all', () => {
		expect(
			spfRecordMatches('v=spf1 include:amazonses.com', 'v=spf1 include:amazonses.com ~all')
		).toBe(false);
	});

	it('ignores our mechanism when it sits after the terminal all, where nobody evaluates it', () => {
		expect(
			spfRecordMatches('v=spf1 -all include:amazonses.com', 'v=spf1 include:amazonses.com ~all')
		).toBe(false);
	});

	it('keeps comparing a generated redirect= literally', () => {
		const expected = 'v=spf1 redirect=_spf.example.test';
		expect(spfRecordMatches('v=spf1 redirect=_spf.example.test', expected)).toBe(true);
		expect(spfRecordMatches('v=spf1 redirect=_spf.other.test', expected)).toBe(false);
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

	it('flags a lowercase v=dmarc1 record at a weaker policy as a partial match', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=dmarc1; p=none']]);
		const results = await runDnsLookups('example.test', {
			dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=reject' },
		} as never);
		expect(results.dmarc).toMatchObject({
			verified: false,
			foundValue: 'v=dmarc1; p=none',
			error: PARTIAL,
		});
	});

	it('verifies a published p=reject against a generated p=none', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=DMARC1; p=reject']]);
		const results = await runDnsLookups('example.test', {
			dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
		} as never);
		expect(results.dmarc).toMatchObject({ verified: true, foundValue: 'v=DMARC1; p=reject' });
	});

	it('fails two DMARC records at _dmarc even when one of them matches', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([
			['v=DMARC1; p=none'],
			['v=DMARC1; p=reject; rua=mailto:reports@vendor.test'],
		]);
		const results = await runDnsLookups('example.test', {
			dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
		} as never);
		expect(results.dmarc).toMatchObject({
			verified: false,
			error: expect.stringContaining('merge them into a single record'),
			foundValue: 'v=DMARC1; p=none | v=DMARC1; p=reject; rua=mailto:reports@vendor.test',
		});
	});

	it('verifies a published -all SPF record against a generated ~all', async () => {
		vi.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=spf1 include:amazonses.com -all']]);
		const results = await runDnsLookups('example.test', {
			spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
		} as never);
		expect(results.spf).toMatchObject({ verified: true });
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

describe('runDnsLookups tells an unanswered lookup from an absent record', () => {
	afterEach(() => vi.restoreAllMocks());

	const DKIM = { type: 'TXT', host: 'sel._domainkey', value: 'v=DKIM1; k=rsa; p=AB' } as const;
	const dnsError = (code: string) =>
		Object.assign(new Error(`queryTxt ${code} sel._domainkey.example.test`), { code });

	it.each(['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED'])(
		'marks a %s answer inconclusive',
		async (code) => {
			vi.spyOn(dns, 'resolveTxt').mockRejectedValue(dnsError(code));
			const results = await runDnsLookups('example.test', { dkim: [DKIM] } as never);
			expect(results.dkim).toEqual([
				expect.objectContaining({ verified: false, inconclusive: true }),
			]);
		}
	);

	it.each(['ENOTFOUND', 'ENODATA'])('treats %s as an authoritative absence', async (code) => {
		vi.spyOn(dns, 'resolveTxt').mockRejectedValue(dnsError(code));
		const results = await runDnsLookups('example.test', { dkim: [DKIM] } as never);
		expect(results.dkim?.[0]).toMatchObject({ verified: false });
		expect(results.dkim?.[0]?.inconclusive).toBeUndefined();
	});

	it('carries the rotation flag of a pending selector onto its result', async () => {
		vi.spyOn(dns, 'resolveTxt').mockImplementation(async (host: string) => {
			if (host.startsWith('sel.')) return [['v=DKIM1; k=rsa; p=AB']];
			throw dnsError('ENOTFOUND');
		});
		const results = await runDnsLookups('example.test', {
			dkim: [
				DKIM,
				{
					type: 'TXT',
					host: 'next._domainkey',
					value: 'v=DKIM1; k=rsa; p=CD',
					rotationPending: true,
				},
			],
		} as never);
		expect(results.dkim).toEqual([
			expect.objectContaining({ verified: true }),
			expect.objectContaining({ verified: false, rotationPending: true }),
		]);
		expect(results.dkim?.[0]?.rotationPending).toBeUndefined();
	});
});
