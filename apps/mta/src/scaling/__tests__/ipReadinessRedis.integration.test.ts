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
	IP_READINESS_ALERT_SCAN_STATE,
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

	function marker(generation: number): [string, string] {
		return [
			`ipv6-readiness-v1:spf:${ip}:${generation}`,
			[
				'spf',
				'missing-ip6-mechanism',
				'1700000000000',
				'IPv6 SPF regressed',
				ip,
				String(generation),
			].join('\x1f'),
		];
	}

	async function seedMarkers(first: number, last: number): Promise<void> {
		for (let start = first; start <= last; start += 1_000) {
			const pipeline = redis.pipeline();
			for (let generation = start; generation <= Math.min(last, start + 999); generation++) {
				const [eventId, value] = marker(generation);
				pipeline.hset(IP_READINESS_ALERTS_PENDING, eventId, value);
			}
			await pipeline.exec();
		}
	}

	it('fairly drains 50k markers across empty pages, restart, additions, and concurrent flushers', async () => {
		const initialMarkerCount = 50_000;
		const addedMarkerCount = 137;
		await seedMarkers(1, initialMarkerCount);

		const countBeforeDrain = await redis.hlen(IP_READINESS_ALERTS_PENDING);
		let injectedEmptyPage = false;
		const redisWithEmptyPage = new Proxy(redis, {
			get(target, property, receiver) {
				if (property === 'hscan') {
					return async (...args: Parameters<Redis['hscan']>) => {
						if (!injectedEmptyPage) {
							injectedEmptyPage = true;
							return ['1', []] as [string, string[]];
						}
						return await target.hscan(...args);
					};
				}
				const value: unknown = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		expect(
			await flushPendingIpReadinessAlerts(redisWithEmptyPage, {} as MtaConfig)
		).toBeLessThanOrEqual(IP_READINESS_ALERT_FLUSH_BATCH_SIZE);
		expect(injectedEmptyPage).toBe(true);
		expect(await redis.hget(IP_READINESS_ALERT_SCAN_STATE, 'cursor')).not.toBe('1');

		// Simulate a process restart: the new client has no in-memory scan state.
		await redis.quit();
		redis = new Redis(port, '127.0.0.1', { maxRetriesPerRequest: 1 });
		await redis.ping();
		const persistedCursor = await redis.hget(IP_READINESS_ALERT_SCAN_STATE, 'cursor');
		expect(persistedCursor).toMatch(/^\d+$/);

		await seedMarkers(initialMarkerCount + 1, initialMarkerCount + addedMarkerCount);
		let invocations = 0;
		while ((await redis.hlen(IP_READINESS_ALERTS_PENDING)) > 0 && invocations < 2_000) {
			const results =
				invocations % 7 === 0
					? await Promise.all([
							flushPendingIpReadinessAlerts(redis, {} as MtaConfig),
							flushPendingIpReadinessAlerts(redis, {} as MtaConfig),
							flushPendingIpReadinessAlerts(redis, {} as MtaConfig),
						])
					: [await flushPendingIpReadinessAlerts(redis, {} as MtaConfig)];
			expect(results.every((processed) => processed <= IP_READINESS_ALERT_FLUSH_BATCH_SIZE)).toBe(
				true
			);
			invocations += 1;
		}
		expect(invocations).toBeLessThan(2_000);
		expect(await redis.hlen(IP_READINESS_ALERTS_PENDING)).toBe(0);
		const ids = vi.mocked(queueConvexWebhook).mock.calls.map((call) => call[3]);
		expect(ids).toHaveLength(countBeforeDrain + addedMarkerCount);
		expect(new Set(ids).size).toBe(ids.length);
	}, 120_000);
});
