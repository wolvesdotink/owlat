import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MtaConfig } from '../../config.js';
import { queueConvexWebhook } from '../../webhooks/convexNotifier.js';
import {
	applyIpPoolObservation,
	IP_READINESS_ALERTS_PENDING,
	nextIpPoolObservationGeneration,
} from '../ipPool.js';
import {
	flushPendingIpReadinessAlerts,
	IP_READINESS_ALERT_FLUSH_BATCH_SIZE,
} from '../ipReadinessAlerts.js';

vi.mock('../../webhooks/convexNotifier.js', () => ({
	queueConvexWebhook: vi.fn().mockResolvedValue('outbox-id'),
}));

function dockerAvailable(): boolean {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5_000 });
		execFileSync('docker', ['image', 'inspect', 'redis:7-alpine'], {
			stdio: 'ignore',
			timeout: 5_000,
		});
		return true;
	} catch {
		return false;
	}
}

describe.runIf(dockerAvailable())('IP readiness atomicity on standalone Redis', () => {
	const port = 19_000 + Math.floor(Math.random() * 1_000);
	const container = `owlat-ip-readiness-${randomUUID().slice(0, 8)}`;
	const ip = '2001:db8::10';
	let redis: Redis;

	beforeAll(async () => {
		execFileSync(
			'docker',
			[
				'run',
				'-d',
				'--rm',
				'--network',
				'host',
				'--name',
				container,
				'redis:7-alpine',
				'redis-server',
				'--port',
				String(port),
				'--appendonly',
				'no',
				'--protected-mode',
				'no',
			],
			{ stdio: 'ignore' }
		);
		redis = new Redis(port, '127.0.0.1', { lazyConnect: true, maxRetriesPerRequest: 1 });
		for (let attempt = 0; attempt < 30; attempt++) {
			try {
				await redis.connect();
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		await redis.ping();
	}, 15_000);

	beforeEach(async () => {
		await redis.flushall();
		vi.mocked(queueConvexWebhook).mockClear().mockResolvedValue('outbox-id');
	});

	afterAll(async () => {
		await redis?.quit();
		try {
			execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
		} catch {
			// Container may already have exited; --rm handled it.
		}
	});

	it('atomically emits one pending marker across racing generation-CAS blocks', async () => {
		await redis.sadd('mta:ip-pool:configured', ip);
		await redis.sadd('mta:ip-pool:active', ip);
		const older = await nextIpPoolObservationGeneration(redis, ip, 'spf');
		const newer = await nextIpPoolObservationGeneration(redis, ip, 'spf');
		const observation = (generation: number) => ({
			ip,
			reason: 'spf' as const,
			generation,
			decision: 'block' as const,
			stateKey: `mta:ipv6-spf:${ip}`,
			stateFields: { verdict: 'fail', reason: 'missing-ip6-mechanism' },
			regressionAlert: {
				check: 'spf' as const,
				reason: 'missing-ip6-mechanism',
				timestamp: 1_700_000_000_000,
				message: 'IPv6 SPF regressed',
			},
		});
		await Promise.all([
			applyIpPoolObservation(redis, observation(newer)),
			applyIpPoolObservation(redis, observation(older)),
			applyIpPoolObservation(redis, observation(newer)),
		]);
		expect(await redis.hlen(IP_READINESS_ALERTS_PENDING)).toBe(1);
		const [eventId] = await redis.hkeys(IP_READINESS_ALERTS_PENDING);
		expect(eventId).toMatch(/^ipv6-readiness-v1:spf:2001:db8::10:\d+$/);
	});

	it('bounds each scan and concurrent replays retain one stable event identity', async () => {
		for (let generation = 1; generation <= IP_READINESS_ALERT_FLUSH_BATCH_SIZE + 1; generation++) {
			const eventId = `ipv6-readiness-v1:spf:${ip}:${generation}`;
			await redis.hset(
				IP_READINESS_ALERTS_PENDING,
				eventId,
				[
					'spf',
					'missing-ip6-mechanism',
					'1700000000000',
					'IPv6 SPF regressed',
					ip,
					String(generation),
				].join('\x1f')
			);
		}
		await flushPendingIpReadinessAlerts(redis, {} as MtaConfig);
		expect(queueConvexWebhook).toHaveBeenCalledTimes(IP_READINESS_ALERT_FLUSH_BATCH_SIZE);
		expect(await redis.hlen(IP_READINESS_ALERTS_PENDING)).toBe(1);

		vi.mocked(queueConvexWebhook).mockClear();
		await Promise.all([
			flushPendingIpReadinessAlerts(redis, {} as MtaConfig),
			flushPendingIpReadinessAlerts(redis, {} as MtaConfig),
		]);
		const ids = vi.mocked(queueConvexWebhook).mock.calls.map((call) => call[3]);
		expect(new Set(ids).size).toBe(1);
		expect(await redis.hlen(IP_READINESS_ALERTS_PENDING)).toBe(0);
	});
});
