/**
 * Unit coverage for the pure IP / RFC 7208 §7 macro helpers split out of the
 * SPF evaluator into `ip.ts`. These functions are side-effect-free string /
 * number arithmetic (no DNS), so they are exercised directly here rather than
 * through `checkSpf`, pinning the IPv6 `::`-expansion, CIDR-match and macro
 * branches that the differential SPF suite does not reach.
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeIp,
	stripIpv4Prefix,
	expandMacros,
	ipMatchesCidr,
	ipv6MatchesCidr,
} from '../ip.js';

describe('normalizeIp / stripIpv4Prefix', () => {
	it('strips the IPv4-mapped IPv6 prefix', () => {
		expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
		expect(stripIpv4Prefix('::ffff:203.0.113.9')).toBe('203.0.113.9');
	});

	it('leaves a plain address untouched', () => {
		expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
		expect(stripIpv4Prefix('2001:db8::1')).toBe('2001:db8::1');
	});
});

describe('expandMacros (RFC 7208 §7)', () => {
	it('returns the input verbatim when there is no macro', () => {
		expect(expandMacros('_spf.example.com', '1.2.3.4', 'example.com')).toBe('_spf.example.com');
	});

	it('expands the literal escapes %% %_ %-', () => {
		expect(expandMacros('a%%b', '1.2.3.4', 'd.com')).toBe('a%b');
		expect(expandMacros('a%_b', '1.2.3.4', 'd.com')).toBe('a b');
		expect(expandMacros('a%-b', '1.2.3.4', 'd.com')).toBe('a%20b');
	});

	it('expands %{i} as a dotted quad for IPv4 (stripping the mapped prefix)', () => {
		expect(expandMacros('%{i}._spf.d.com', '::ffff:5.6.7.8', 'd.com')).toBe('5.6.7.8._spf.d.com');
	});

	it('expands %{i} as 32 dot-separated nibbles for IPv6', () => {
		// 2001:db8::1 → 2001:0db8:0000...0001, split into single hex nibbles.
		const expanded = expandMacros('%{i}', '2001:db8::1', 'd.com');
		const nibbles = expanded.split('.');
		expect(nibbles).toHaveLength(32);
		expect(nibbles.join('')).toBe('2001' + '0db8' + '0000'.repeat(5) + '0001');
	});

	it('leaves %{i} verbatim when the sender IP is unparsable', () => {
		expect(expandMacros('%{i}', 'not-an-ip', 'd.com')).toBe('not-an-ip');
	});

	it('expands %{d}, %{s} and %{o} to the domain', () => {
		expect(expandMacros('%{d}', '1.2.3.4', 'd.com')).toBe('d.com');
		expect(expandMacros('%{s}', '1.2.3.4', 'd.com')).toBe('d.com');
		expect(expandMacros('%{o}', '1.2.3.4', 'd.com')).toBe('d.com');
	});

	it('leaves an unrecognised macro verbatim', () => {
		expect(expandMacros('%{z}', '1.2.3.4', 'd.com')).toBe('%{z}');
	});
});

describe('ipMatchesCidr (IPv4)', () => {
	it('matches a bare address exactly', () => {
		expect(ipMatchesCidr('1.2.3.4', '1.2.3.4')).toBe(true);
		expect(ipMatchesCidr('1.2.3.4', '1.2.3.5')).toBe(false);
	});

	it('matches inside / outside a CIDR range', () => {
		expect(ipMatchesCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
		expect(ipMatchesCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
	});

	it('treats a /0 prefix as matching everything', () => {
		expect(ipMatchesCidr('1.2.3.4', '5.6.7.8/0')).toBe(true);
	});

	it('rejects a non-numeric prefix length', () => {
		expect(ipMatchesCidr('10.0.0.5', '10.0.0.0/xx')).toBe(false);
	});

	it('rejects an empty network', () => {
		expect(ipMatchesCidr('10.0.0.5', '/24')).toBe(false);
	});

	it('rejects a malformed connecting IP (wrong octet count)', () => {
		expect(ipMatchesCidr('1.2.3', '1.2.3.0/24')).toBe(false);
	});

	it('rejects an out-of-range octet', () => {
		expect(ipMatchesCidr('999.1.1.1', '10.0.0.0/24')).toBe(false);
	});
});

describe('ipv6MatchesCidr (RFC 7208 §5.6)', () => {
	it('matches a bare address exactly', () => {
		expect(ipv6MatchesCidr('2001:db8::1', '2001:db8::1')).toBe(true);
		expect(ipv6MatchesCidr('2001:db8::2', '2001:db8::1')).toBe(false);
	});

	it('matches on a nibble-aligned CIDR prefix', () => {
		expect(ipv6MatchesCidr('2001:db8:1234::5', '2001:db8::/32')).toBe(true);
		expect(ipv6MatchesCidr('2001:dead::1', '2001:db8::/32')).toBe(false);
	});

	it('matches on a non-nibble-aligned prefix (/33)', () => {
		expect(ipv6MatchesCidr('2001:db80:7000::1', '2001:db80::/33')).toBe(true);
		expect(ipv6MatchesCidr('2001:db80:8000::1', '2001:db80::/33')).toBe(false);
	});

	it('rejects an out-of-range or non-numeric prefix length', () => {
		expect(ipv6MatchesCidr('2001:db8::1', '2001:db8::/129')).toBe(false);
		expect(ipv6MatchesCidr('2001:db8::1', '2001:db8::/-1')).toBe(false);
		expect(ipv6MatchesCidr('2001:db8::1', '2001:db8::/xx')).toBe(false);
	});

	it('rejects an unparsable IPv6 address (no colon)', () => {
		expect(ipv6MatchesCidr('1.2.3.4', '1.2.3.4')).toBe(false);
	});

	it('rejects an address with two "::" compressions', () => {
		expect(ipv6MatchesCidr('2001::db8::1', '2001:db8::/32')).toBe(false);
	});

	it('rejects an over-long address (more than 8 groups)', () => {
		expect(ipv6MatchesCidr('1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8')).toBe(false);
	});

	it('rejects a short address with no "::" compression', () => {
		expect(ipv6MatchesCidr('1:2:3', '1:2:3')).toBe(false);
	});

	it('rejects an address with a non-hex group', () => {
		expect(ipv6MatchesCidr('2001:db8::zzzz', '2001:db8::/32')).toBe(false);
	});

	it('expands a fully written-out address', () => {
		expect(ipv6MatchesCidr('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1')).toBe(true);
	});
});
