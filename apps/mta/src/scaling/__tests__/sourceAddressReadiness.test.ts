import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { SmtpReachabilityDeps } from '../../routes/smtpReachability.js';
import { initializePools } from '../ipPool.js';
import { runSourceAddressReadinessCheck } from '../sourceAddressReadiness.js';

const IPV4 = '203.0.113.10';
const IPV6 = '2001:db8::10';
const config = { ipPools: { transactional: [IPV4], campaign: [IPV4, IPV6] } };

function deps(errorCode?: string): SmtpReachabilityDeps {
	return {
		resolveMx: vi.fn().mockResolvedValue([{ exchange: 'mx.example.net', priority: 10 }]),
		resolve6: vi.fn().mockResolvedValue(['2001:db8::25']),
		connect: errorCode
			? vi.fn().mockRejectedValue(Object.assign(new Error(errorCode), { code: errorCode }))
			: vi.fn().mockResolvedValue(undefined),
		now: () => 1_000,
	};
}

describe('source-address readiness', () => {
	it('keeps IPv6 quarantined at boot until a source-bound probe passes', async () => {
		const redis = new Redis();
		await redis.hset(`mta:fcrdns:${IPV6}`, 'verdict', 'pass', 'checkedAt', '1');
		await redis.hset(`mta:ipv6-spf:${IPV6}`, 'verdict', 'pass', 'checkedAt', '1');
		await initializePools(redis, config.ipPools);
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(0);

		await runSourceAddressReadinessCheck(redis, config, deps());
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(1);
	});

	it('preserves a prior pass on remote/network uncertainty but blocks EADDRNOTAVAIL', async () => {
		const redis = new Redis();
		await redis.hset(`mta:fcrdns:${IPV6}`, 'verdict', 'pass', 'checkedAt', '1');
		await redis.hset(`mta:ipv6-spf:${IPV6}`, 'verdict', 'pass', 'checkedAt', '1');
		await redis.hset(`mta:source-address-readiness:${IPV6}`, 'verdict', 'pass', 'checkedAt', '1');
		await initializePools(redis, config.ipPools);

		await runSourceAddressReadinessCheck(redis, config, deps('ENETUNREACH'));
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(1);

		await runSourceAddressReadinessCheck(redis, config, deps('EADDRNOTAVAIL'));
		expect(await redis.sismember('mta:ip-pool:active', IPV6)).toBe(0);
	});
});
