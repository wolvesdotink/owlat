import { describe, expect, it } from 'vitest';
import {
	ipAddressFamily,
	ipRateLimitKey,
	ipv6HexNibbles,
	isLoopbackHostname,
	isLoopbackIp,
	isPrivateOrLoopbackIp,
	normalizeIpAddress,
	normalizePeerIp,
	parseIpAddress,
	reverseIpAddressForDns,
	unmapIpv4,
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

describe('normalizePeerIp', () => {
	it('unmaps IPv4-mapped peers and canonicalizes native IPv6', () => {
		expect(normalizePeerIp(' 203.0.113.7 ')).toBe('203.0.113.7');
		expect(normalizePeerIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
		expect(normalizePeerIp('::FFFF:CB00:7107')).toBe('203.0.113.7');
		expect(normalizePeerIp('2001:0DB8:0:0::0001')).toBe('2001:db8::1');
	});

	it('rejects values that are not a bare address', () => {
		for (const invalid of ['unknown', '', '[2001:db8::1]', '203.0.113.7:25', 'fe80::1%eth0']) {
			expect(normalizePeerIp(invalid)).toBeNull();
		}
	});
});

describe('ipRateLimitKey', () => {
	it('keys IPv4 peers, mapped or not, on the full address', () => {
		expect(ipRateLimitKey('203.0.113.7')).toBe('203.0.113.7');
		expect(ipRateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
	});

	it('keys every address of one IPv6 /64 on the same prefix', () => {
		const key = ipRateLimitKey('2001:db8:1:2::1');
		expect(key).toBe('2001:db8:1:2::/64');
		expect(ipRateLimitKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc')).toBe(key);
		expect(ipRateLimitKey('2001:db8:1:3::1')).not.toBe(key);
		expect(ipRateLimitKey('2001:db8::1')).toBe('2001:db8::/64');
		expect(ipRateLimitKey('::1')).toBe('::/64');
	});

	it('passes a non-address placeholder through unchanged', () => {
		expect(ipRateLimitKey('unknown')).toBe('unknown');
	});
});

describe('unmapIpv4', () => {
	it('keeps the byte-exact output the connection-slot keys were built with', () => {
		expect(unmapIpv4('1.2.3.4')).toBe('1.2.3.4');
		expect(unmapIpv4('::ffff:1.2.3.4')).toBe('1.2.3.4');
		expect(unmapIpv4('2001:db8::1')).toBe('2001:db8::1');
		expect(unmapIpv4('unknown')).toBe('unknown');
	});

	it('unmaps the WHATWG hex spelling of a mapped address', () => {
		expect(normalizeIpAddress('::ffff:10.0.0.1')).toBe('::ffff:a00:1');
		expect(unmapIpv4('::ffff:a00:1')).toBe('10.0.0.1');
		expect(unmapIpv4('::FFFF:7F00:1')).toBe('127.0.0.1');
		expect(unmapIpv4('::ffff:0:0')).toBe('0.0.0.0');
	});

	it('leaves native IPv6 spellings alone rather than canonicalizing them', () => {
		expect(unmapIpv4('2001:0DB8::0001')).toBe('2001:0DB8::0001');
		expect(unmapIpv4('::1')).toBe('::1');
		expect(unmapIpv4('::ffff:not-an-ip')).toBe('::ffff:not-an-ip');
	});
});

describe('loopback and private classifiers', () => {
	// [input, isLoopbackIp, isPrivateOrLoopbackIp, isLoopbackHostname]
	const table: Array<[string, boolean, boolean, boolean]> = [
		['127.0.0.1', true, true, true],
		['127.0.0.2', true, true, true],
		['::ffff:127.0.0.1', true, true, true],
		['::ffff:7f00:2', true, true, true],
		['::1', true, true, true],
		['0:0:0:0:0:0:0:1', true, true, true],
		['[::1]', false, false, true],
		['localhost', false, false, true],
		['localhost.', false, false, true],
		[' LocalHost ', false, false, true],
		['app.localhost', false, false, false],
		['10.0.0.1', false, true, false],
		['::ffff:10.0.0.1', false, true, false],
		['172.16.0.1', false, true, false],
		['172.17.0.2', false, true, false],
		['172.20.0.1', false, true, false],
		['172.31.255.255', false, true, false],
		['172.32.0.1', false, false, false],
		['172.15.0.1', false, false, false],
		['192.168.1.1', false, true, false],
		['::ffff:192.168.1.1', false, true, false],
		['192.169.0.1', false, false, false],
		['8.8.8.8', false, false, false],
		['::ffff:8.8.8.8', false, false, false],
		['2001:db8::1', false, false, false],
		['fd00::1', false, false, false],
		['127.0.0.01', false, false, false],
		['127.1', false, false, false],
		['not an ip', false, false, false],
		['', false, false, false],
	];

	it.each(table)('%j', (input, loopback, privateOrLoopback, loopbackHostname) => {
		expect(isLoopbackIp(input)).toBe(loopback);
		expect(isPrivateOrLoopbackIp(input)).toBe(privateOrLoopback);
		expect(isLoopbackHostname(input)).toBe(loopbackHostname);
	});
});
