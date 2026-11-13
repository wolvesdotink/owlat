/**
 * MX host address resolution (smtp/mxAddresses.ts): the non-public screen,
 * the authoritative-versus-temporary split, and the answer cache.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMxAddressResolver, reachableFamilies } from '../mxAddresses.js';

type Answer = string[] | string;

function fakeDns(answers: Record<string, { a?: Answer; aaaa?: Answer; ttl?: number }>) {
	const lookup = (family: 'a' | 'aaaa') =>
		vi.fn(async (host: string) => {
			const entry = answers[host];
			const answer = entry?.[family];
			if (answer === undefined || typeof answer === 'string') {
				throw Object.assign(new Error(`query ${answer ?? 'ENOTFOUND'}`), {
					code: answer ?? 'ENOTFOUND',
				});
			}
			return answer.map((address) => ({ address, ttl: entry?.ttl ?? 300 }));
		});
	return { resolve4: lookup('a'), resolve6: lookup('aaaa') };
}

const screened = { allowPrivate: false };

describe('createMxAddressResolver', () => {
	it.each([
		['loopback', ['127.0.0.1'], []],
		['RFC 1918 10/8', ['10.20.30.40'], []],
		['RFC 1918 172.16/12', ['172.20.0.1'], []],
		['RFC 1918 192.168/16', ['192.168.0.25'], []],
		['IPv4 link-local', ['169.254.169.254'], []],
		['unspecified', ['0.0.0.0'], ['::']],
		['multicast', ['224.0.0.1'], ['ff02::1']],
		['IPv6 loopback', [], ['::1']],
		['IPv6 link-local', [], ['fe80::1']],
		['IPv6 unique-local', [], ['fd00::25']],
		['IPv4-mapped private', [], ['::ffff:10.0.0.1']],
		['IPv4-mapped loopback (hex form)', [], ['::ffff:7f00:1']],
	])('refuses a host that resolves only to %s', async (_, a, aaaa) => {
		const resolver = createMxAddressResolver(
			fakeDns({
				'mx.example.com': { a: a.length ? a : 'ENODATA', aaaa: aaaa.length ? aaaa : 'ENODATA' },
			})
		);

		const resolution = await resolver.resolve('mx.example.com', screened);

		expect(resolution).toEqual({ status: 'refused', addresses: [...a, ...aaaa] });
	});

	it('keeps the public addresses of a host that has both kinds, by family, in DNS order', async () => {
		const resolver = createMxAddressResolver(
			fakeDns({
				'mx.example.com': {
					a: ['10.0.0.1', '192.0.2.25', '192.0.2.26'],
					aaaa: ['fe80::1', '2001:db8::25'],
				},
			})
		);

		expect(await resolver.resolve('mx.example.com', screened)).toEqual({
			status: 'resolved',
			ipv4: ['192.0.2.25', '192.0.2.26'],
			ipv6: ['2001:db8::25'],
		});
	});

	it('connects to non-public addresses when allowPrivate is set', async () => {
		const resolver = createMxAddressResolver(fakeDns({ 'mx.example.com': { a: ['10.0.0.1'] } }));

		expect(await resolver.resolve('mx.example.com', { allowPrivate: true })).toEqual({
			status: 'resolved',
			ipv4: ['10.0.0.1'],
			ipv6: [],
		});
	});

	it('answers localhost names and address literals without DNS, and screens them', async () => {
		const dns = fakeDns({});
		const resolver = createMxAddressResolver(dns);

		expect(await resolver.resolve('localhost.', screened)).toEqual({
			status: 'refused',
			addresses: ['127.0.0.1', '::1'],
		});
		expect(await resolver.resolve('mx.localhost', screened)).toMatchObject({ status: 'refused' });
		expect(await resolver.resolve('[10.0.0.1]', screened)).toMatchObject({ status: 'refused' });
		expect(await resolver.resolve('192.0.2.25', screened)).toEqual({
			status: 'resolved',
			ipv4: ['192.0.2.25'],
			ipv6: [],
		});
		expect(dns.resolve4).not.toHaveBeenCalled();
		expect(dns.resolve6).not.toHaveBeenCalled();
	});

	it('reports not-found only when both lookups are authoritatively empty', async () => {
		const resolver = createMxAddressResolver(
			fakeDns({
				'nodata.example.com': { a: 'ENODATA', aaaa: 'ENODATA' },
				'half.example.com': { a: 'ENODATA', aaaa: 'ESERVFAIL' },
				'timeout.example.com': { a: 'ETIMEOUT', aaaa: 'ETIMEOUT' },
			})
		);

		expect(await resolver.resolve('nodata.example.com', screened)).toEqual({ status: 'not-found' });
		expect(await resolver.resolve('nxdomain.example.com', screened)).toEqual({
			status: 'not-found',
		});
		expect(await resolver.resolve('half.example.com', screened)).toMatchObject({
			status: 'temporary-failure',
		});
		expect(await resolver.resolve('timeout.example.com', screened)).toMatchObject({
			status: 'temporary-failure',
		});
	});

	it('a private answer next to a failed lookup is a temporary failure, not a refusal', async () => {
		const resolver = createMxAddressResolver(
			fakeDns({ 'mx.example.com': { a: ['10.0.0.1'], aaaa: 'ESERVFAIL' } })
		);

		expect(await resolver.resolve('mx.example.com', screened)).toMatchObject({
			status: 'temporary-failure',
		});
	});

	it('caches an answer for its TTL, and a failed lookup not at all', async () => {
		let now = 1_000_000;
		const answers: Record<string, { a?: Answer; aaaa?: Answer; ttl?: number }> = {
			'mx.example.com': { a: ['192.0.2.25'], aaaa: 'ENODATA', ttl: 30 },
			'flaky.example.com': { a: 'ESERVFAIL', aaaa: 'ESERVFAIL' },
		};
		const dns = fakeDns(answers);
		const resolver = createMxAddressResolver(dns, () => now);

		await resolver.resolve('mx.example.com', screened);
		await resolver.resolve('MX.example.com.', screened);
		expect(dns.resolve4).toHaveBeenCalledTimes(1);

		now += 31_000;
		await resolver.resolve('mx.example.com', screened);
		expect(dns.resolve4).toHaveBeenCalledTimes(2);

		await resolver.resolve('flaky.example.com', screened);
		await resolver.resolve('flaky.example.com', screened);
		expect(dns.resolve4.mock.calls.filter(([host]) => host === 'flaky.example.com')).toHaveLength(
			2
		);
	});
});

describe('reachableFamilies', () => {
	it('is the union of the families the hosts have connectable addresses in', async () => {
		const resolver = createMxAddressResolver(
			fakeDns({
				'mx1.example.com': { a: ['192.0.2.25'], aaaa: 'ENODATA' },
				'mx2.example.com': { a: 'ENODATA', aaaa: ['fe80::1'] },
			})
		);

		const families = await reachableFamilies(
			['mx1.example.com', 'mx2.example.com'],
			screened,
			(host, options) => resolver.resolve(host, options)
		);

		expect(families).toEqual(new Set(['ipv4']));
	});

	it('is null when no host has a connectable address', async () => {
		const resolver = createMxAddressResolver(fakeDns({}));

		expect(
			await reachableFamilies(['mx1.example.com'], screened, (host, options) =>
				resolver.resolve(host, options)
			)
		).toBeNull();
	});
});
