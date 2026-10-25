import type Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerRedisAvailable } from '../../__tests__/helpers/redisCluster.js';
import {
	startRedisStandaloneFixture,
	stopRedisStandaloneFixture,
	type RedisStandaloneFixture,
} from '../../__tests__/helpers/redisStandalone.js';
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

describe.runIf(dockerRedisAvailable())('IP readiness atomicity on standalone Redis', () => {
	const ip = '2001:db8::10';
	let fixture: RedisStandaloneFixture | undefined;
	let redis: Redis;

	beforeAll(async () => {
		fixture = await startRedisStandaloneFixture('ip-readiness');
		redis = fixture.client;
	});

	beforeEach(async () => {
		await redis.flushall();
		vi.mocked(queueConvexWebhook).mockClear().mockResolvedValue('outbox-id');
	});

	afterAll(async () => {
		await stopRedisStandaloneFixture(fixture);
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

	/** One HSCAN a flusher sent: the cursor it started from and the one Redis returned. */
	interface ScanPage {
		from: string;
		next: string;
	}

	/**
	 * `client` with every HSCAN recorded into `pages`. With `emptyFirstPage`, the
	 * first scan answers an empty page with a non-zero cursor, which Redis may do
	 * on any sparse hash table.
	 */
	function recordingScans(client: Redis, pages: ScanPage[], emptyFirstPage = false): Redis {
		let injectEmptyPage = emptyFirstPage;
		return new Proxy(client, {
			get(target, property, receiver) {
				if (property === 'hscan') {
					return async (...args: Parameters<Redis['hscan']>) => {
						const page: [string, string[]] = injectEmptyPage
							? ['1', []]
							: await target.hscan(...args);
						injectEmptyPage = false;
						pages.push({ from: String(args[1]), next: page[0] });
						return page;
					};
				}
				const value: unknown = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	// Each marker value is longer than Redis's 64-byte `hash-max-listpack-value`,
	// so the pending hash is a hash table at any field count (the encoding
	// assertion below pins this): HSCAN pages through it and the drain's deletes
	// shrink it mid-scan. A flusher that restarted its scan from cursor 0 would
	// rescan an ever longer drained prefix; on a large enough hash its page limit
	// runs out before it reaches a marker and the backlog stalls. The recorded
	// cursors prove the resumption directly, at any size.
	it('drains a paged hash in cursor order across empty pages, restart, additions, and concurrent flushers', async () => {
		const initialMarkerCount = 300;
		const addedMarkerCount = 137;
		await seedMarkers(1, initialMarkerCount);
		expect(await redis.object('ENCODING', IP_READINESS_ALERTS_PENDING)).toBe('hashtable');

		const pages: ScanPage[] = [];
		expect(
			await flushPendingIpReadinessAlerts(recordingScans(redis, pages, true), {} as MtaConfig)
		).toBeLessThanOrEqual(IP_READINESS_ALERT_FLUSH_BATCH_SIZE);
		// The empty page neither ended the pass nor reset the cursor.
		expect(pages[0]).toEqual({ from: '0', next: '1' });
		expect(pages[1]?.from).toBe('1');
		expect(await redis.hget(IP_READINESS_ALERT_SCAN_STATE, 'cursor')).toBe(pages.at(-1)!.next);

		// Simulate a process restart: the new client has no in-memory scan state.
		const restarted = redis.duplicate();
		await redis.quit();
		redis = restarted;
		// Teardown quits the fixture's client, which is now the restarted one.
		fixture!.client = restarted;
		await redis.ping();
		const persistedCursor = await redis.hget(IP_READINESS_ALERT_SCAN_STATE, 'cursor');
		expect(persistedCursor).toMatch(/^\d+$/);

		await seedMarkers(initialMarkerCount + 1, initialMarkerCount + addedMarkerCount);
		const remaining = await redis.hlen(IP_READINESS_ALERTS_PENDING);
		const flusher = recordingScans(redis, pages);
		// Each pass that holds the lock queues up to one batch, so a fair drain
		// needs about one pass per batch; twice that allows for passes that only
		// cross empty pages, and a stalled scan exceeds it.
		const passLimit = 2 * Math.ceil(remaining / IP_READINESS_ALERT_FLUSH_BATCH_SIZE);
		let passes = 0;
		while ((await redis.hlen(IP_READINESS_ALERTS_PENDING)) > 0 && passes <= passLimit) {
			const results =
				passes % 7 === 0
					? await Promise.all([
							flushPendingIpReadinessAlerts(flusher, {} as MtaConfig),
							flushPendingIpReadinessAlerts(flusher, {} as MtaConfig),
							flushPendingIpReadinessAlerts(flusher, {} as MtaConfig),
						])
					: [await flushPendingIpReadinessAlerts(flusher, {} as MtaConfig)];
			expect(results.every((processed) => processed <= IP_READINESS_ALERT_FLUSH_BATCH_SIZE)).toBe(
				true
			);
			passes += 1;
		}
		expect(passes).toBeLessThanOrEqual(passLimit);
		expect(await redis.hlen(IP_READINESS_ALERTS_PENDING)).toBe(0);
		// Every page started where the one before it ended: across passes, the
		// restart and the concurrent flushers, the scan never went back to 0
		// before Redis said a full iteration was done.
		const restartedFrom = pages.findIndex(
			(page, index) => index > 0 && page.from !== pages[index - 1]!.next
		);
		expect(restartedFrom).toBe(-1);
		const ids = vi.mocked(queueConvexWebhook).mock.calls.map((call) => call[3]);
		expect(ids).toHaveLength(initialMarkerCount + addedMarkerCount);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
