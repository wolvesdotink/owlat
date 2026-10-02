import { describe, expect, it } from 'vitest';
import {
	dmarcReportAuthorizationRecord,
	normalizeDmarcReportAddress,
	resolveDmarcReportAddress,
} from '../dmarcReportAddress';

describe('resolveDmarcReportAddress', () => {
	it('defaults to dmarc-reports@ on the return-path domain', () => {
		expect(resolveDmarcReportAddress(undefined, 'Bounces.Example.com.')).toBe(
			'dmarc-reports@bounces.example.com'
		);
	});

	it('prefers a configured address, bare or as a mailto: URI', () => {
		expect(resolveDmarcReportAddress('mailto:Reports@Example.org', 'bounces.example.com')).toBe(
			'reports@example.org'
		);
		expect(resolveDmarcReportAddress(' reports@example.org ', undefined)).toBe(
			'reports@example.org'
		);
	});

	it('is off when configured off or when there is nothing to derive it from', () => {
		expect(resolveDmarcReportAddress('OFF', 'bounces.example.com')).toBeNull();
		expect(resolveDmarcReportAddress(undefined, undefined)).toBeNull();
		expect(resolveDmarcReportAddress('', '  ')).toBeNull();
	});

	it('rejects a configured value that is not an address', () => {
		expect(resolveDmarcReportAddress('not-an-address', 'bounces.example.com')).toBeNull();
	});
});

describe('normalizeDmarcReportAddress', () => {
	it('drops URI parameters and the size limit', () => {
		expect(normalizeDmarcReportAddress('mailto:r@example.com!10m')).toBe('r@example.com');
		expect(normalizeDmarcReportAddress('mailto:r@example.com?subject=x')).toBe('r@example.com');
	});

	it('refuses lists and partial addresses', () => {
		expect(normalizeDmarcReportAddress('a@x.com,b@y.com')).toBeNull();
		expect(normalizeDmarcReportAddress('@example.com')).toBeNull();
		expect(normalizeDmarcReportAddress('r@')).toBeNull();
	});
});

describe('dmarcReportAuthorizationRecord', () => {
	it('is not needed inside the same organizational domain', () => {
		expect(
			dmarcReportAuthorizationRecord('mail.example.com', 'dmarc-reports@bounces.example.com')
		).toBeNull();
		expect(
			dmarcReportAuthorizationRecord('example.co.uk', 'dmarc-reports@bounces.example.co.uk')
		).toBeNull();
	});

	it('names the RFC 7489 §7.1 record for a foreign report domain', () => {
		expect(
			dmarcReportAuthorizationRecord('customer.org', 'dmarc-reports@bounces.example.com')
		).toEqual({
			type: 'TXT',
			hostname: 'customer.org._report._dmarc.bounces.example.com',
			value: 'v=DMARC1',
		});
	});
});
