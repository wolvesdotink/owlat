import { describe, expect, it } from 'vitest';
import {
	ipAddressFamily,
	ipv6HexNibbles,
	normalizeIpAddress,
	parseIpAddress,
	reverseIpAddressForDns,
} from '../ipAddress';

describe('IP address parsing', () => {
	it('accepts canonical IPv4 and rejects ambiguous legacy forms', () => {
		expect(parseIpAddress(' 203.0.113.10 ')).toEqual({
			address: '203.0.113.10',
			family: 'ipv4',
		});
		for (const invalid of ['203.0.113', '203.0.113.256', '203.0.113.010', '0x7f.0.0.1']) {
			expect(parseIpAddress(invalid)).toBeNull();
		}
	});

	it('canonicalizes equivalent IPv6 spellings and rejects URI/zone/CIDR syntax', () => {
		expect(normalizeIpAddress('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
		expect(ipAddressFamily('2001:db8::1')).toBe('ipv6');
		for (const invalid of ['[2001:db8::1]', 'fe80::1%eth0', '2001:db8::/64', '[::1]:25']) {
			expect(parseIpAddress(invalid)).toBeNull();
		}
	});
});

describe('DNS address reversal', () => {
	it('reverses IPv4 octets', () => {
		expect(reverseIpAddressForDns('203.0.113.10')).toBe('10.113.0.203');
	});

	it('expands and reverses all 32 IPv6 nibbles', () => {
		expect(ipv6HexNibbles('2001:db8::1')).toBe('20010db8000000000000000000000001');
		expect(reverseIpAddressForDns('2001:db8::1')).toBe(
			'1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2'
		);
	});
});
