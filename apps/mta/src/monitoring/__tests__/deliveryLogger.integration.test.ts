/**
 * #925 on real Redis: the record script, the XINFO coverage gate, trimming,
 * TTL expiry, days written without the indexes, and Redis Cluster slotting.
 */

import type Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	dockerRedisAvailable,
	startRedisClusterFixture,
	stopRedisClusterFixture,
	type RedisClusterFixture,
} from '../../__tests__/helpers/redisCluster.js';
import {
	startRedisStandaloneFixture,
	stopRedisStandaloneFixture,
	type RedisStandaloneFixture,
} from '../../__tests__/helpers/redisStandalone.js';
import type { MtaConfig } from '../../config.js';
import {
	getDeliveryLogStats,
	getMessageEvents,
	logDeliveryEvent,
	type DeliveryEvent,
} from '../deliveryLogger.js';
import {
	messageIndexKeyFor,
	readDayIndex,
	statsKeyFor,
	streamKeyFor,
} from '../deliveryLogIndex.js';

vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const today = new Date().toISOString().split('T')[0]!;
const config = { deliveryLogMaxLen: 100_000, deliveryLogTtlHours: 72 } as MtaConfig;

function event(i: number, overrides: Partial<DeliveryEvent> = {}): DeliveryEvent {
	return {
		messageId: `m-${i}`,
		to: `r${i}@example.com`,
		from: 'sender@example.com',
		orgId: `org-${i % 3}`,
		status: i % 2 === 0 ? 'delivered' : 'deferred',
		domain: 'example.com',
		...overrides,
	};
}

/** Count XRANGE commands the client sends while `run` executes. */
async function countXrange(redis: Redis, run: () => Promise<unknown>): Promise<number> {
	let count = 0;
	const original = redis.sendCommand.bind(redis);
	redis.sendCommand = ((command: { name: string }, ...rest: unknown[]) => {
		if (command.name.toLowerCase() === 'xrange') count += 1;
		return (original as (...args: unknown[]) => unknown)(command, ...rest);
	}) as typeof redis.sendCommand;
	try {
		await run();
	} finally {
		redis.sendCommand = original;
	}
	return count;
}

describe.runIf(dockerRedisAvailable())('delivery log indexes on standalone Redis', () => {
	let fixture: RedisStandaloneFixture;
	let redis: Redis;

	beforeAll(async () => {
		fixture = await startRedisStandaloneFixture('delivery-log');
		redis = fixture.client;
	}, 15_000);

	beforeEach(async () => {
		await redis.flushall();
	});

	afterAll(async () => {
		await stopRedisStandaloneFixture(fixture);
	});

	it('answers 1,001 indexed events from the counters and the message index', async () => {
		for (let i = 0; i < 1001; i++) {
			await logDeliveryEvent(redis, event(i, i % 400 === 0 ? { messageId: 'target' } : {}), config);
		}

		let stats: Record<string, number> = {};
		let history: Awaited<ReturnType<typeof getMessageEvents>> = [];
		const scans = await countXrange(redis, async () => {
			stats = await getDeliveryLogStats(redis, today, 'org-1');
			history = await getMessageEvents(redis, 'target');
		});

		expect(stats).toMatchObject({ total: 334, delivered: 167, deferred: 167 });
		expect(history.map((e) => e.messageId)).toEqual(['target', 'target', 'target']);
		expect(new Set(history.map((e) => e.id)).size).toBe(3);
		// Only the three indexed IDs are read back from the stream.
		expect(scans).toBe(3);
		expect((await getDeliveryLogStats(redis, today))['total']).toBe(1001);
	});

	it('falls back to the retained entries once MAXLEN trimmed the day', async () => {
		const small = { ...config, deliveryLogMaxLen: 100 } as MtaConfig;
		await logDeliveryEvent(redis, event(0, { messageId: 'target' }), small);
		for (let i = 1; i < 1000; i++) await logDeliveryEvent(redis, event(i), small);
		await logDeliveryEvent(redis, event(1000, { messageId: 'target' }), small);

		const retained = await redis.xlen(streamKeyFor(today));
		expect(retained).toBeLessThan(1001);
		expect((await getDeliveryLogStats(redis, today))['total']).toBe(retained);
		const history = await getMessageEvents(redis, 'target');
		expect(history).toHaveLength(1);
	});

	it('scans a day that holds entries written without the indexes', async () => {
		await redis.xadd(
			streamKeyFor(today),
			'*',
			'messageId',
			'old',
			'orgId',
			'org-9',
			'status',
			'bounced'
		);
		for (let i = 0; i < 5; i++) await logDeliveryEvent(redis, event(i, { orgId: 'org-9' }), config);

		const { coverage } = await readDayIndex(redis, today, 'stats');
		expect(coverage).toMatchObject({ kind: 'known', entriesAdded: 6, indexedTotal: 5 });
		expect(await getDeliveryLogStats(redis, today, 'org-9')).toMatchObject({
			total: 6,
			bounced: 1,
		});
		expect(await getMessageEvents(redis, 'old')).toHaveLength(1);
	});

	it('expires the indexes together with the stream', async () => {
		const shortLived = { ...config, deliveryLogTtlHours: 1 / 3600 } as MtaConfig;
		await logDeliveryEvent(redis, event(0, { messageId: 'target' }), shortLived);
		const streamTtl = await redis.pttl(streamKeyFor(today));
		expect(streamTtl).toBeGreaterThan(0);
		for (const key of [statsKeyFor(today), messageIndexKeyFor(today)]) {
			const ttl = await redis.pttl(key);
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(streamTtl);
		}

		await new Promise((resolve) => setTimeout(resolve, 1_200));

		expect(
			await redis.exists(streamKeyFor(today), statsKeyFor(today), messageIndexKeyFor(today))
		).toBe(0);
		expect((await getDeliveryLogStats(redis, today))['total']).toBe(0);
		expect(await getMessageEvents(redis, 'target')).toEqual([]);
	});
});

describe.runIf(dockerRedisAvailable())('delivery log indexes on Redis Cluster', () => {
	let fixture: RedisClusterFixture;

	beforeAll(async () => {
		fixture = await startRedisClusterFixture('delivery-log');
	}, 60_000);

	afterAll(async () => {
		await stopRedisClusterFixture(fixture);
	});

	it('keeps the stream and its indexes in one slot', async () => {
		const redis = fixture.client as unknown as Redis;
		for (let i = 0; i < 4; i++)
			await logDeliveryEvent(redis, event(i, { messageId: 'target' }), config);

		const { coverage } = await readDayIndex(redis, today, 'stats');
		expect(coverage).toMatchObject({ kind: 'known', entriesAdded: 4, indexedTotal: 4, length: 4 });
		expect((await getDeliveryLogStats(redis, today))['total']).toBe(4);
		expect(await getMessageEvents(redis, 'target')).toHaveLength(4);
	});
});
