import { describe, expect, it } from 'vitest';
import { isDisallowedIpAddress } from '../ipBlocklist';

describe('isDisallowedIpAddress — NAT64 prefixes', () => {
	it('classifies the well-known prefix 64:ff9b::/96 by its embedded IPv4', () => {
		expect(isDisallowedIpAddress('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
		expect(isDisallowedIpAddress('64:ff9b::10.0.0.1')).toBe(true);
		expect(isDisallowedIpAddress('64:ff9b::8.8.8.8')).toBe(false);
	});

	it('blocks all of the local-use prefix 64:ff9b:1::/48 (RFC 8215)', () => {
		// The local-use prefix may translate to private IPv4, and where the IPv4
		// sits in it is network-specific, so a public-looking tail proves nothing.
		expect(isDisallowedIpAddress('64:ff9b:1::a9fe:a9fe')).toBe(true);
		expect(isDisallowedIpAddress('64:ff9b:1::7f00:1')).toBe(true);
		expect(isDisallowedIpAddress('64:ff9b:1::8.8.8.8')).toBe(true);
		expect(isDisallowedIpAddress('64:ff9b:1:ffff:ffff:ffff:ffff:ffff')).toBe(true);
		expect(isDisallowedIpAddress('[64:ff9b:1::1]')).toBe(true);
	});

	it('leaves addresses just outside the local-use prefix to the other rules', () => {
		expect(isDisallowedIpAddress('64:ff9b:2::1')).toBe(false);
		expect(isDisallowedIpAddress('64:ff9a:1::1')).toBe(false);
	});
});
