import type { networkInterfaces } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isGlobalAddress, resolveSourceAddress } from '../sourceAddress.js';

type Interfaces = ReturnType<typeof networkInterfaces>;

function iface(address: string, family: 'IPv4' | 'IPv6' = 'IPv4') {
	return {
		address,
		family,
		netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::',
		mac: '02:42:ac:14:00:09',
		internal: address === '127.0.0.1' || address === '::1',
		cidr: null,
		...(family === 'IPv6' ? { scopeid: 0 } : {}),
	} as NonNullable<Interfaces[string]>[number];
}

/** A Docker bridge container: loopback plus one private bridge address. */
const DOCKER_BRIDGE: Interfaces = {
	lo: [iface('127.0.0.1'), iface('::1', 'IPv6')],
	eth0: [iface('172.20.0.9')],
};

/** A host-networked MTA that owns its public address. */
const HOST_NETWORK: Interfaces = {
	lo: [iface('127.0.0.1')],
	eth0: [iface('8.8.4.4'), iface('2a01:4f8::1', 'IPv6')],
};

describe('isGlobalAddress', () => {
	it.each(['8.8.4.4', '2a01:4f8::1'])('treats %s as globally routable', (ip) => {
		expect(isGlobalAddress(ip)).toBe(true);
	});

	it.each([
		'10.0.0.1',
		'172.20.0.9',
		'192.168.1.1',
		'127.0.0.1',
		'100.64.0.1',
		'203.0.113.10',
		'::1',
		'fd00::1',
		'fe80::1',
		'2001:db8::10',
		'not-an-ip',
	])('treats %s as not globally routable', (ip) => {
		expect(isGlobalAddress(ip)).toBe(false);
	});
});

describe('resolveSourceAddress', () => {
	it('binds nothing for a public pool IP behind Docker NAT', () => {
		expect(resolveSourceAddress('8.8.4.4', DOCKER_BRIDGE)).toBeUndefined();
	});

	it('binds a pool IP that is assigned to a local interface', () => {
		expect(resolveSourceAddress('8.8.4.4', HOST_NETWORK)).toBe('8.8.4.4');
		expect(resolveSourceAddress('2a01:4f8::1', HOST_NETWORK)).toBe('2a01:4f8::1');
	});

	it('keeps binding (and failing loudly) when the host owns a different public address', () => {
		// A typo or a not-yet-assigned IP on a host-networked box must not silently
		// leave from the host's primary address instead.
		expect(resolveSourceAddress('8.8.8.8', HOST_NETWORK)).toBe('8.8.8.8');
	});

	it('always binds IPv6 explicitly, even behind NAT', () => {
		// The OS must never pick an IPv6 source whose PTR/SPF readiness was not checked.
		expect(resolveSourceAddress('2a01:4f8::2', DOCKER_BRIDGE)).toBe('2a01:4f8::2');
	});

	it('only a public IPv4 on an interface makes an IPv4 pool address strict', () => {
		const ipv6Only: Interfaces = { eth0: [iface('172.20.0.9'), iface('2a01:4f8::1', 'IPv6')] };
		expect(resolveSourceAddress('8.8.4.4', ipv6Only)).toBeUndefined();
	});

	it('always binds private and documentation addresses as configured', () => {
		expect(resolveSourceAddress('10.0.0.1', DOCKER_BRIDGE)).toBe('10.0.0.1');
		expect(resolveSourceAddress('203.0.113.10', DOCKER_BRIDGE)).toBe('203.0.113.10');
	});
});
