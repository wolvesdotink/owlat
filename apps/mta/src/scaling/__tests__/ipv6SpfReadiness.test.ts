import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import { initializePools } from '../ipPool.js';
import {
	getIpv6SpfReadiness,
	runIpv6SpfReadinessCheck,
	verifyIpv6SpfReadiness,
} from '../ipv6SpfReadiness.js';

const IPV4 = '203.0.113.10';
const IPV6 = '2001:db8::10';
const config = {
	ipPools: { transactional: [IPV4], campaign: [IPV4, IPV6] },
	returnPathDomain: 'bounce.example.com',
};

function dns(records: string[] | Error) {
	return {
		resolveTxt:
			records instanceof Error
				? vi.fn().mockRejectedValue(records)
				: vi.fn().mockResolvedValue(records.map((record) => [record])),
		now: () => 1_000,
	};
}

async function initializedRedis() {
	const redis = new Redis();
	await redis.flushall();
	for (const ip of [IPV4, IPV6]) {
		await redis.hset(`mta:fcrdns:${ip}`, 'verdict', 'pass', 'checkedAt', '1');
	}
	await redis.hset(`mta:source-address-readiness:${IPV6}`, 'verdict', 'pass', 'checkedAt', '1');
	await initializePools(redis, config.ipPools);
	return redis;
}

describe('IPv6 SPF readiness', () => {
	it('requires one SPF record with the exact canonical ip6 mechanism', async () => {
		await expect(
			verifyIpv6SpfReadiness(
				IPV6,
				config.returnPathDomain,
				dns(['v=spf1 ip4:203.0.113.10 ip6:2001:0DB8:0:0:0:0:0:10 -all'])
			)
		).resolves.toMatchObject({ verdict: 'pass' });
		await expect(
			verifyIpv6SpfReadiness(IPV6, config.returnPathDomain, dns(['v=spf1 ip4:203.0.113.10 -all']))
		).resolves.toMatchObject({ verdict: 'fail', reason: 'missing-ip6-mechanism' });
		await expect(
			verifyIpv6SpfReadiness(
				IPV6,
				config.returnPathDomain,
				dns(['v=spf1 ip6:2001:db8::10 -all', 'v=spf1 include:relay.example -all'])
			)
		).resolves.toMatchObject({ verdict: 'fail', reason: 'multiple-spf-records' });
	});

	it('blocks before rotation, admits a verified address, and demotes an SPF regression', async () => {
		const redis = await initializedRedis();
		await runIpv6SpfReadinessCheck(
			redis,
			config,
			dns(Object.assign(new Error('missing'), { code: 'ENOTFOUND' }))
		);
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(0);
		expect(await getIpv6SpfReadiness(redis, IPV6)).toMatchObject({
			verdict: 'fail',
			reason: 'no-spf-record',
		});

		await runIpv6SpfReadinessCheck(redis, config, dns([`v=spf1 ip4:${IPV4} ip6:${IPV6} -all`]));
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(1);

		await runIpv6SpfReadinessCheck(redis, config, dns([`v=spf1 ip4:${IPV4} -all`]));
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(0);
		expect(await redis.sismember('mta:ip-pool:active', IPV4)).toBe(1);
		const alerts = await redis.hvals('mta:ip-readiness-alerts:pending');
		expect(alerts).toHaveLength(1);
		expect(alerts.map((raw) => raw.split('\x1f'))).toContainEqual(
			expect.arrayContaining(['spf', 'missing-ip6-mechanism', IPV6])
		);
	});

	it('preserves the last eligibility decision through transient DNS failure', async () => {
		const redis = await initializedRedis();
		await runIpv6SpfReadinessCheck(redis, config, dns([`v=spf1 ip4:${IPV4} ip6:${IPV6} -all`]));
		await runIpv6SpfReadinessCheck(
			redis,
			config,
			dns(Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' }))
		);
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(1);
		expect(await getIpv6SpfReadiness(redis, IPV6)).toMatchObject({
			verdict: 'error',
			reason: 'lookup-error',
		});
	});
});
