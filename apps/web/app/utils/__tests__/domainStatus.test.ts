import { describe, expect, it } from 'vitest';
import {
	getStatusBadgeClass,
	getStatusIcon,
	normalizeDnsRecord,
	hasDnsRecords,
} from '../domainStatus';

describe('getStatusBadgeClass', () => {
	it('maps known statuses to their tone classes', () => {
		expect(getStatusBadgeClass('verified')).toContain('text-success');
		expect(getStatusBadgeClass('failed')).toContain('text-error');
		expect(getStatusBadgeClass('registering')).toContain('text-info');
	});

	it('falls back to the warning tone for pending / unknown', () => {
		expect(getStatusBadgeClass('pending')).toContain('text-warning');
		expect(getStatusBadgeClass('something-else')).toContain('text-warning');
	});
});

describe('getStatusIcon', () => {
	it('maps known statuses to their icons', () => {
		expect(getStatusIcon('verified')).toBe('lucide:check-circle-2');
		expect(getStatusIcon('failed')).toBe('lucide:x-circle');
		expect(getStatusIcon('registering')).toBe('lucide:loader-2');
	});

	it('falls back to the pending clock icon for unknown statuses', () => {
		expect(getStatusIcon('unknown')).toBe('lucide:clock');
	});
});

describe('normalizeDnsRecord', () => {
	it('returns null when the record has no value', () => {
		expect(normalizeDnsRecord(null, 'TXT')).toBeNull();
		expect(normalizeDnsRecord(undefined, 'TXT')).toBeNull();
		expect(normalizeDnsRecord({ value: '' }, 'TXT')).toBeNull();
	});

	it('defaults host to @ and applies the fallback type', () => {
		expect(normalizeDnsRecord({ value: 'v=spf1 -all' }, 'TXT')).toEqual({
			type: 'TXT',
			host: '@',
			value: 'v=spf1 -all',
			hostIsFqdn: false,
		});
	});

	it('prefers a relative host and marks it not-FQDN', () => {
		expect(normalizeDnsRecord({ type: 'CNAME', host: 's1._domainkey', value: 'x' }, 'TXT')).toEqual(
			{ type: 'CNAME', host: 's1._domainkey', value: 'x', hostIsFqdn: false }
		);
	});

	it('flags an absolute hostname (no relative host) as FQDN', () => {
		// The MTA return-path record carries `hostname` and no `host`.
		expect(
			normalizeDnsRecord({ type: 'TXT', hostname: 'bounces.owlat.com', value: 'x' }, 'TXT')
		).toEqual({ type: 'TXT', host: 'bounces.owlat.com', value: 'x', hostIsFqdn: true });
	});
});

describe('hasDnsRecords', () => {
	it('is false when nothing is configured', () => {
		expect(hasDnsRecords(null)).toBe(false);
		expect(hasDnsRecords(undefined)).toBe(false);
		expect(hasDnsRecords({})).toBe(false);
		expect(hasDnsRecords({ dkim: [] })).toBe(false);
	});

	it('is true when any record family is present', () => {
		expect(hasDnsRecords({ spf: { value: 'v=spf1 -all' } })).toBe(true);
		expect(hasDnsRecords({ dkim: [{ value: 'k=rsa' }] })).toBe(true);
		expect(hasDnsRecords({ dmarc: { value: 'v=DMARC1' } })).toBe(true);
		expect(hasDnsRecords({ mailFrom: [{ value: 'x' }] })).toBe(true);
	});
});
