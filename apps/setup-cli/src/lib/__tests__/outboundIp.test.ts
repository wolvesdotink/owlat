import { describe, it, expect } from 'vitest';
import { applyOutboundIpDefaults, pickPrimaryIpv4, type InterfaceAddress } from '../outboundIp.js';

const hetznerBox: InterfaceAddress[] = [
	{ name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true },
	{ name: 'lo', address: '::1', family: 'IPv6', internal: true },
	{ name: 'eth0', address: '195.201.2.211', family: 'IPv4', internal: false },
	{ name: 'eth0', address: '2a01:4f8:1c1c:2792::1', family: 'IPv6', internal: false },
	{ name: 'docker0', address: '172.17.0.1', family: 'IPv4', internal: false },
	{ name: 'br-3f2a1c', address: '172.18.0.1', family: 'IPv4', internal: false },
];

describe('pickPrimaryIpv4', () => {
	it('returns the routable IPv4 and skips loopback, IPv6 and docker bridges', () => {
		expect(pickPrimaryIpv4(hetznerBox)).toBe('195.201.2.211');
	});

	it('skips bridges even when they are listed before the uplink', () => {
		const reordered = [...hetznerBox].reverse();
		expect(pickPrimaryIpv4(reordered)).toBe('195.201.2.211');
	});

	it('accepts the numeric family Node 18 reports', () => {
		expect(
			pickPrimaryIpv4([{ name: 'ens3', address: '10.0.0.5', family: 4, internal: false }])
		).toBe('10.0.0.5');
	});

	it('returns undefined when only loopback, link-local or bridge addresses exist', () => {
		expect(
			pickPrimaryIpv4([
				{ name: 'lo', address: '127.0.0.1', family: 'IPv4', internal: true },
				{ name: 'eth0', address: '169.254.10.2', family: 'IPv4', internal: false },
				{ name: 'docker0', address: '172.17.0.1', family: 'IPv4', internal: false },
			])
		).toBeUndefined();
	});
});

describe('applyOutboundIpDefaults', () => {
	it('sets both pools when neither is configured', () => {
		const env: Record<string, string> = {};
		expect(applyOutboundIpDefaults(env, '195.201.2.211')).toBe(true);
		expect(env).toEqual({
			IP_POOLS_TRANSACTIONAL: '195.201.2.211',
			IP_POOLS_CAMPAIGN: '195.201.2.211',
		});
	});

	it('never overrides an operator-configured pool, even a partial one', () => {
		const env: Record<string, string> = { IP_POOLS_CAMPAIGN: '203.0.113.9' };
		expect(applyOutboundIpDefaults(env, '195.201.2.211')).toBe(false);
		expect(env).toEqual({ IP_POOLS_CAMPAIGN: '203.0.113.9' });
	});

	it('is a no-op without a detected address', () => {
		const env: Record<string, string> = {};
		expect(applyOutboundIpDefaults(env, undefined)).toBe(false);
		expect(env).toEqual({});
	});
});
