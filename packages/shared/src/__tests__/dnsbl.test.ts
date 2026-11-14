import { describe, expect, it } from 'vitest';
import {
	DNSBL_LISTS,
	DOMAIN_BLOCKLIST_IDS,
	DOMAIN_BLOCKLISTS,
	dnsblZoneHost,
	isDnsblUnknownReason,
	isSpamhausDqsKey,
	readDomainBlocklistAnswer,
} from '../dnsbl';

describe('dnsblZoneHost', () => {
	it('moves Spamhaus to its keyed zone only when given its own key', () => {
		expect(dnsblZoneHost(DNSBL_LISTS.spamhaus, undefined)).toBe('zen.spamhaus.org');
		expect(dnsblZoneHost(DNSBL_LISTS.spamhaus, 'abcdefghijklmnopqrstuvwxyz')).toBe(
			'abcdefghijklmnopqrstuvwxyz.zen.dq.spamhaus.net'
		);
	});

	it('leaves unkeyed feeds on their public zone', () => {
		expect(dnsblZoneHost(DNSBL_LISTS.barracuda, 'anything')).toBe('b.barracudacentral.org');
	});
});

describe('isSpamhausDqsKey', () => {
	it('accepts one DNS label of letters and digits', () => {
		expect(isSpamhausDqsKey('abcdefghijklmnopqrstuvwxyz')).toBe(true);
		expect(isSpamhausDqsKey('ABCdef0123456789')).toBe(true);
	});

	it('refuses anything that would change the shape of the queried name', () => {
		expect(isSpamhausDqsKey('short')).toBe(false);
		expect(isSpamhausDqsKey('abcdefghijklmnop.evil.example')).toBe(false);
		expect(isSpamhausDqsKey('abcdefghijklmnop qrst')).toBe(false);
		expect(isSpamhausDqsKey('a'.repeat(65))).toBe(false);
	});
});

describe('isDnsblUnknownReason', () => {
	it('knows the reasons and nothing else', () => {
		expect(isDnsblUnknownReason('resolver_refused')).toBe(true);
		expect(isDnsblUnknownReason('resolver_policy')).toBe(false);
		expect(isDnsblUnknownReason(undefined)).toBe(false);
	});
});

describe('readDomainBlocklistAnswer', () => {
	it('reads NXDOMAIN as clean on every list', () => {
		for (const id of DOMAIN_BLOCKLIST_IDS) {
			expect(readDomainBlocklistAnswer(id, [])).toEqual({ status: 'clean' });
		}
	});

	it('reads a documented listing code as listed', () => {
		expect(readDomainBlocklistAnswer('spamhaus_dbl', ['127.0.1.2'])).toEqual({ status: 'listed' });
		expect(readDomainBlocklistAnswer('spamhaus_dbl', ['127.0.1.102'])).toEqual({
			status: 'listed',
		});
		expect(readDomainBlocklistAnswer('surbl', ['127.0.0.8'])).toEqual({ status: 'listed' });
		expect(readDomainBlocklistAnswer('uribl', ['127.0.0.2'])).toEqual({ status: 'listed' });
	});

	it('reads "you may not query from here" as unknown, never listed or clean', () => {
		expect(readDomainBlocklistAnswer('spamhaus_dbl', ['127.255.255.254'])).toEqual({
			status: 'unknown',
			reason: 'resolver_refused',
		});
		expect(readDomainBlocklistAnswer('spamhaus_dbl', ['127.255.255.255'])).toEqual({
			status: 'unknown',
			reason: 'rate_limited',
		});
		expect(readDomainBlocklistAnswer('surbl', ['127.0.0.1'])).toEqual({
			status: 'unknown',
			reason: 'resolver_refused',
		});
		expect(readDomainBlocklistAnswer('uribl', ['127.0.0.1'])).toEqual({
			status: 'unknown',
			reason: 'resolver_refused',
		});
	});

	it('does not count a URIBL grey or red flag as a listing', () => {
		expect(readDomainBlocklistAnswer('uribl', ['127.0.0.4'])).toEqual({ status: 'clean' });
		expect(readDomainBlocklistAnswer('uribl', ['127.0.0.8'])).toEqual({ status: 'clean' });
	});

	it('reads an answer outside the documented codes as unknown', () => {
		expect(readDomainBlocklistAnswer('spamhaus_dbl', ['127.0.1.255'])).toEqual({
			status: 'unknown',
			reason: 'unusable_answer',
		});
		expect(readDomainBlocklistAnswer('surbl', ['192.0.2.1'])).toEqual({
			status: 'unknown',
			reason: 'unusable_answer',
		});
	});

	it('names a delisting page for every list', () => {
		for (const id of DOMAIN_BLOCKLIST_IDS) {
			expect(DOMAIN_BLOCKLISTS[id].delistingUrl).toMatch(/^https:\/\//);
		}
	});
});
