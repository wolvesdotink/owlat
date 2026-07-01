import { describe, it, expect } from 'vitest';
import {
	summarizeDomainReadiness,
	domainReadinessMessage,
} from '../domainReadiness';

describe('summarizeDomainReadiness', () => {
	it('reports all-verified when every present record verifies', () => {
		const summary = summarizeDomainReadiness(
			{
				spf: { verified: true },
				dkim: [{ verified: true }, { verified: true }],
				dmarc: { verified: true },
				mailFrom: [{ verified: true }],
			},
			{
				spf: { value: 'v=spf1 ...' },
				dkim: [{ value: 'a' }, { value: 'b' }],
				dmarc: { value: 'v=DMARC1' },
				mailFrom: [{ value: 'mx' }],
			}
		);
		expect(summary.total).toBe(4);
		expect(summary.verified).toBe(4);
		expect(summary.allVerified).toBe(true);
		expect(summary.missingLabels).toEqual([]);
		expect(domainReadinessMessage(summary)).toBe('All records verified');
	});

	it('flags a single missing record as "almost ready"', () => {
		const summary = summarizeDomainReadiness(
			{
				spf: { verified: true },
				dkim: [{ verified: true }],
				dmarc: { verified: false },
			},
			{
				spf: { value: 'v=spf1 ...' },
				dkim: [{ value: 'a' }],
				dmarc: { value: 'v=DMARC1' },
			}
		);
		expect(summary.total).toBe(3);
		expect(summary.verified).toBe(2);
		expect(summary.allVerified).toBe(false);
		expect(summary.missingLabels).toEqual(['DMARC']);
		expect(domainReadinessMessage(summary)).toBe(
			'Almost ready — just add the DMARC record'
		);
	});

	it('does not count a record category the domain does not have', () => {
		// No SPF in dnsRecords, and a stray verification entry for it — SPF must
		// not be counted, so DKIM alone drives an all-verified result.
		const summary = summarizeDomainReadiness(
			{
				spf: { verified: false },
				dkim: [{ verified: true }],
			},
			{
				dkim: [{ value: 'a' }],
			}
		);
		expect(summary.total).toBe(1);
		expect(summary.verified).toBe(1);
		expect(summary.allVerified).toBe(true);
		expect(summary.chips.map((c) => c.label)).toEqual(['DKIM']);
	});

	it('marks a multi-record category unverified when any one record fails', () => {
		const summary = summarizeDomainReadiness(
			{ dkim: [{ verified: true }, { verified: false }] },
			{ dkim: [{ value: 'a' }, { value: 'b' }] }
		);
		expect(summary.missingLabels).toEqual(['DKIM']);
		expect(summary.allVerified).toBe(false);
	});

	it('fails soft on empty inputs', () => {
		const summary = summarizeDomainReadiness(undefined, undefined);
		expect(summary.total).toBe(0);
		expect(summary.allVerified).toBe(false);
		expect(summary.chips).toEqual([]);
		expect(domainReadinessMessage(summary)).toBe('No DNS records to verify yet');
	});

	it('lists multiple missing records in the tail', () => {
		const summary = summarizeDomainReadiness(
			{ spf: { verified: false }, dmarc: { verified: false } },
			{ spf: { value: 's' }, dmarc: { value: 'd' } }
		);
		expect(summary.missingLabels).toEqual(['SPF', 'DMARC']);
		expect(domainReadinessMessage(summary)).toBe(
			'Add the SPF and DMARC records to finish setup'
		);
	});
});
