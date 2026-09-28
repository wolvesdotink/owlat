import { describe, expect, it } from 'vitest';
import { DNSBL_LISTS, dnsblZoneHost, isDnsblUnknownReason, isSpamhausDqsKey } from '../dnsbl';

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
