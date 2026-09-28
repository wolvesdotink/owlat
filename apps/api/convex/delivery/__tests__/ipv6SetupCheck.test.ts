import { describe, expect, it } from 'vitest';
import {
	checkIpv6SendingAddress,
	isPublicIpv6,
	withAddress,
	type Ipv6SetupDnsDeps,
	type Ipv6SetupInput,
} from '../ipv6SetupCheck';

// 2001:db8::/32 is the documentation prefix, which the check refuses; tests
// that must pass use an address from 2a01:4f8::/32 that no fixture resolves.
const ADDRESS = '2a01:4f8:c0c:1::25';

const INPUT: Ipv6SetupInput = {
	address: ADDRESS,
	ehloHostname: 'mail.example.com',
	returnPathDomain: 'bounces.example.com',
	pools: { transactional: ['203.0.113.25'], campaign: ['203.0.113.25', '203.0.113.26'] },
};

function missing(): never {
	throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
}

function deps(overrides: Partial<Ipv6SetupDnsDeps> = {}): Ipv6SetupDnsDeps {
	return {
		reverse: async () => ['mail.example.com.'],
		resolve6: async () => ['2a01:04f8:0c0c:0001:0000:0000:0000:0025'],
		resolveTxt: async () => [['v=spf1 ip4:203.0.113.25 ', `ip6:${ADDRESS} -all`]],
		now: () => 1_000,
		...overrides,
	};
}

describe('checkIpv6SendingAddress', () => {
	it('passes a fully published address and hands back both pools with it appended', async () => {
		const result = await checkIpv6SendingAddress(INPUT, deps());
		expect(result).toEqual({
			ok: true,
			address: ADDRESS,
			ehloHostname: 'mail.example.com',
			returnPathDomain: 'bounces.example.com',
			ready: true,
			checks: [
				{ id: 'ptr', status: 'pass', found: ['mail.example.com'] },
				{ id: 'aaaa', status: 'pass', found: [ADDRESS] },
				{ id: 'spf', status: 'pass', found: [] },
			],
			env: {
				MTA_IPV6_ENABLED: 'true',
				IP_POOLS_TRANSACTIONAL: `203.0.113.25,${ADDRESS}`,
				IP_POOLS_CAMPAIGN: `203.0.113.25,203.0.113.26,${ADDRESS}`,
			},
		});
	});

	it('says which record is missing or wrong, and is not ready', async () => {
		const result = await checkIpv6SendingAddress(
			INPUT,
			deps({
				reverse: async () => ['static.25.example-hosting.net'],
				resolve6: missing,
				resolveTxt: async () => [['v=spf1 ip4:203.0.113.25 -all']],
			})
		);
		expect(result.ok && result.ready).toBe(false);
		expect(result.ok && result.checks).toEqual([
			{ id: 'ptr', status: 'fail', reason: 'mismatch', found: ['static.25.example-hosting.net'] },
			{ id: 'aaaa', status: 'fail', reason: 'missing', found: [] },
			{ id: 'spf', status: 'fail', reason: 'missing-ip6-mechanism', found: [] },
		]);
	});

	it('reports a missing SPF record, not a lookup failure, when the name has no TXT', async () => {
		const result = await checkIpv6SendingAddress(INPUT, deps({ resolveTxt: missing }));
		expect(result.ok && result.checks[2]).toEqual({
			id: 'spf',
			status: 'fail',
			reason: 'no-spf-record',
			found: [],
		});
	});

	it('reports a resolver outage as a lookup error rather than a missing record', async () => {
		const outage = async (): Promise<never> => {
			throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
		};
		const result = await checkIpv6SendingAddress(
			INPUT,
			deps({ reverse: outage, resolve6: outage, resolveTxt: outage })
		);
		expect(result.ok && result.checks.map((check) => check.reason)).toEqual([
			'lookup-error',
			'lookup-error',
			'lookup-error',
		]);
	});

	it('leaves the pool lines out when the MTA has not reported its pools', async () => {
		const result = await checkIpv6SendingAddress({ ...INPUT, pools: null }, deps());
		expect(result.ok && result.env).toEqual({ MTA_IPV6_ENABLED: 'true' });
	});

	it.each([
		['not an address', 'invalid-address'],
		['203.0.113.25', 'invalid-address'],
		['[2a01:4f8::25]', 'invalid-address'],
		['2a01:4f8::/64', 'invalid-address'],
		['fe80::1', 'not-public'],
		['fd00::25', 'not-public'],
		['::ffff:203.0.113.25', 'not-public'],
		['2001:db8::25', 'not-public'],
	])('refuses %s (%s)', async (address, refusal) => {
		expect(await checkIpv6SendingAddress({ ...INPUT, address }, deps())).toEqual({
			ok: false,
			refusal,
		});
	});

	it('refuses without an EHLO name or return-path domain to check against', async () => {
		expect(await checkIpv6SendingAddress({ ...INPUT, ehloHostname: undefined }, deps())).toEqual({
			ok: false,
			refusal: 'no-ehlo-hostname',
		});
		expect(
			await checkIpv6SendingAddress({ ...INPUT, returnPathDomain: 'localhost' }, deps())
		).toEqual({ ok: false, refusal: 'no-return-path-domain' });
	});

	it('refuses a pool with no IPv4 address, which the MTA would not boot with', async () => {
		expect(
			await checkIpv6SendingAddress(
				{ ...INPUT, pools: { transactional: ['203.0.113.25'], campaign: [] } },
				deps()
			)
		).toEqual({ ok: false, refusal: 'no-ipv4-in-pool' });
	});
});

describe('withAddress', () => {
	it('does not add an address twice, however it is spelled', () => {
		expect(withAddress(['203.0.113.25', '2A01:4F8:C0C:1:0::25'], ADDRESS)).toBe(
			'203.0.113.25,2A01:4F8:C0C:1:0::25'
		);
	});
});

describe('isPublicIpv6', () => {
	it('accepts global unicast outside the documentation prefix', () => {
		expect(isPublicIpv6(ADDRESS)).toBe(true);
		expect(isPublicIpv6('2001:db8::25')).toBe(false);
		expect(isPublicIpv6('::1')).toBe(false);
		expect(isPublicIpv6('ff02::1')).toBe(false);
	});
});
