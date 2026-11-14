import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import {
	classifyEgressAddress,
	getEgressAddressReadiness,
	runEgressAddressReadinessCheck,
	type EgressAddressDeps,
} from '../egressAddressReadiness.js';
import { getPoolStatus, initializePools } from '../ipPool.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const CONFIGURED = '203.0.113.10';
const OTHER = '203.0.113.99';
const config = {
	ipPools: { transactional: [CONFIGURED], campaign: [CONFIGURED] },
	ehloHostname: 'mail.example.com',
	ehloHostnames: {},
};

/** Documentation ranges stand in for public addresses. */
const isPublicAddress = (ip: string) => !ip.startsWith('10.') && !ip.startsWith('127.');

function deps(replies: Record<string, string[] | Error>): EgressAddressDeps {
	return {
		resolveMx: vi
			.fn()
			.mockImplementation(async (domain: string) => [{ exchange: `mx.${domain}`, priority: 10 }]),
		resolve4: vi
			.fn()
			.mockImplementation(async (host: string) => [
				host === 'mx.gmail.com' ? '192.0.2.1' : '192.0.2.2',
			]),
		resolve6: vi.fn().mockResolvedValue([]),
		exchange: vi.fn(async ({ host }) => {
			const reply = replies[host];
			if (!reply || reply instanceof Error) throw reply ?? new Error('no reply');
			return reply;
		}),
		now: () => 5_000,
		domains: ['gmail.com', 'outlook.com'],
		sourceAddressFor: () => undefined,
		isPublicAddress,
	};
}

const greeting = (address: string) => [
	`250-mx.example.net at your service, [${address}]`,
	'250-SIZE 157286400',
	'250 SMTPUTF8',
];

async function bootedRedis() {
	const redis = new Redis();
	await redis.flushall();
	await redis.hset(`mta:fcrdns:${CONFIGURED}`, 'verdict', 'pass', 'checkedAt', '1');
	await initializePools(redis, config.ipPools);
	return redis;
}

async function blockReasons(redis: InstanceType<typeof Redis>) {
	return (await getPoolStatus(redis, config.ipPools))[0]?.blockReasons;
}

describe('egress-address readiness', () => {
	it('holds an IP whose mail receivers see arrive from another address', async () => {
		const redis = await bootedRedis();
		expect(await redis.sismember('mta:ip-pool:active', CONFIGURED)).toBe(1);

		const [result] = await runEgressAddressReadinessCheck(
			redis,
			config,
			deps({ '192.0.2.1': greeting(OTHER), '192.0.2.2': [`250 hello [${OTHER}]`] })
		);

		expect(result).toMatchObject({ verdict: 'fail', reason: 'address-mismatch', observed: OTHER });
		expect(await redis.sismember('mta:ip-pool:active', CONFIGURED)).toBe(0);
		expect(await blockReasons(redis)).toEqual(['egress-address']);
	});

	it('blocks nothing and says unverified when no receiver names an address', async () => {
		const redis = await bootedRedis();

		const [result] = await runEgressAddressReadinessCheck(
			redis,
			config,
			deps({ '192.0.2.1': new Error('ETIMEDOUT'), '192.0.2.2': ['250 mx.example.net'] })
		);

		expect(result).toMatchObject({ verdict: 'unverified', reason: 'not-observed' });
		expect(await redis.sismember('mta:ip-pool:active', CONFIGURED)).toBe(1);
		expect(await blockReasons(redis)).toEqual([]);
		expect(await getEgressAddressReadiness(redis, CONFIGURED)).toMatchObject({
			verdict: 'unverified',
		});
	});

	it('keeps a confirmed mismatch through an unverified sweep and releases it on a match', async () => {
		const redis = await bootedRedis();
		await runEgressAddressReadinessCheck(redis, config, deps({ '192.0.2.1': greeting(OTHER) }));
		expect(await redis.sismember('mta:ip-pool:active', CONFIGURED)).toBe(0);

		await runEgressAddressReadinessCheck(redis, config, deps({}));
		expect(await redis.sismember('mta:ip-pool:active', CONFIGURED)).toBe(0);
		expect(await getEgressAddressReadiness(redis, CONFIGURED)).toMatchObject({
			verdict: 'unverified',
			observed: OTHER,
		});

		await runEgressAddressReadinessCheck(
			redis,
			config,
			deps({ '192.0.2.1': greeting(CONFIGURED) })
		);
		expect(await redis.sismember('mta:ip-pool:active', CONFIGURED)).toBe(1);
		expect(await blockReasons(redis)).toEqual([]);
	});

	it('does not probe an address no receiver could confirm', async () => {
		const redis = new Redis();
		const probe = deps({});
		const [result] = await runEgressAddressReadinessCheck(
			redis,
			{ ...config, ipPools: { transactional: ['127.0.0.1'], campaign: [] } },
			probe
		);
		expect(result).toMatchObject({ verdict: 'unverified', reason: 'not-public' });
		expect(probe.exchange).not.toHaveBeenCalled();
	});
});

describe('classifyEgressAddress', () => {
	const at = (observed: string | null, mx = 'mx.example.net') => ({
		domain: 'example.net',
		mx,
		observed,
	});

	it('passes when the receivers agree on the configured address', () => {
		expect(
			classifyEgressAddress(CONFIGURED, [at(CONFIGURED), at(null)], 1, isPublicAddress)
		).toEqual({
			ip: CONFIGURED,
			verdict: 'pass',
			observed: CONFIGURED,
			target: 'mx.example.net',
			checkedAt: 1,
		});
	});

	it('is unverified when receivers disagree', () => {
		expect(
			classifyEgressAddress(CONFIGURED, [at(CONFIGURED), at(OTHER)], 1, isPublicAddress)
		).toMatchObject({ verdict: 'unverified', reason: 'inconsistent' });
	});

	it('ignores a private or other-family address a receiver names', () => {
		expect(
			classifyEgressAddress(CONFIGURED, [at('10.0.0.5'), at('2001:db8::5')], 1, isPublicAddress)
		).toMatchObject({ verdict: 'unverified', reason: 'not-observed' });
	});
});
