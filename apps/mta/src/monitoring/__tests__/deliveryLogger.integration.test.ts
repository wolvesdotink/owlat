/**
 * #925 on real Redis: the record script, the XINFO coverage gate, trimming,
 * TTL expiry, days written without the indexes, query pagination, and Redis
 * Cluster slotting.
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
	queryDeliveryLogs,
	type DeliveryEvent,
	type DeliveryLogQuery,
} from '../deliveryLogger.js';
import {
	messageIndexKeyFor,
	orgStatsKeyFor,
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

/** Status counts of the retained stream, the way a scan computes them. */
async function retainedCounts(redis: Redis, orgId?: string): Promise<Record<string, number>> {
	const counts: Record<string, number> = { total: 0 };
	for (const [, fields] of await redis.xrange(streamKeyFor(today), '-', '+')) {
		const map: Record<string, string> = {};
		for (let i = 0; i < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
		if (orgId && map['orgId'] !== orgId) continue;
		counts[map['status']!] = (counts[map['status']!] ?? 0) + 1;
		counts['total']! += 1;
	}
	return counts;
}

/** Follow `nextCursor` until it is absent and return every entry ID. */
async function walkQuery(redis: Redis, query: DeliveryLogQuery): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < 1_000; i++) {
		const page = await queryDeliveryLogs(redis, { ...query, cursor });
		ids.push(...page.entries.map((e) => e.id));
		if (!page.nextCursor) return ids;
		cursor = page.nextCursor;
	}
	throw new Error('pagination did not end');
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

	it('trims the day to MAXLEN exactly and answers its statistics from the counters', async () => {
		const small = { ...config, deliveryLogMaxLen: 100 } as MtaConfig;
		await logDeliveryEvent(redis, event(0, { messageId: 'target' }), small);
		for (let i = 1; i < 1000; i++) await logDeliveryEvent(redis, event(i), small);
		await logDeliveryEvent(redis, event(1000, { messageId: 'target' }), small);

		expect(await redis.xlen(streamKeyFor(today))).toBe(100);
		const { coverage } = await readDayIndex(redis, today, 'stats');
		expect(coverage).toMatchObject({
			kind: 'known',
			length: 100,
			entriesAdded: 1001,
			evicted: 901,
		});
		for (const orgId of [undefined, 'org-0', 'org-1', 'org-2']) {
			const expected = await retainedCounts(redis, orgId);
			let stats: Record<string, number> = {};
			const scans = await countXrange(redis, async () => {
				stats = await getDeliveryLogStats(redis, today, orgId);
			});
			expect(stats).toMatchObject(expected);
			expect(scans).toBe(0);
		}
		// Org hashes an eviction touches keep the stream's expiry.
		for (const orgId of ['org-0', 'org-1', 'org-2']) {
			expect(await redis.pttl(orgStatsKeyFor(today, orgId))).toBeGreaterThan(0);
		}
		const history = await getMessageEvents(redis, 'target');
		expect(history).toHaveLength(1);
	});

	it('scans a day an older MTA trimmed with MAXLEN ~', async () => {
		const small = { ...config, deliveryLogMaxLen: 100 } as MtaConfig;
		for (let i = 0; i < 300; i++) await logDeliveryEvent(redis, event(i), small);
		for (let i = 300; i < 600; i++) {
			await redis.xadd(
				streamKeyFor(today),
				'MAXLEN',
				'~',
				'50',
				'*',
				'messageId',
				`m-${i}`,
				'orgId',
				'org-1',
				'status',
				'bounced'
			);
		}

		const expected = await retainedCounts(redis, 'org-1');
		expect(await getDeliveryLogStats(redis, today, 'org-1')).toMatchObject(expected);
	});

	it('pages a filtered day of 2,000 events with no duplicates or gaps', async () => {
		for (let i = 0; i < 2000; i++) await logDeliveryEvent(redis, event(i), config);
		const all = await redis.xrange(streamKeyFor(today), '-', '+');
		const expected = all
			.filter(([, fields]) => fields[fields.indexOf('orgId') + 1] === 'org-2')
			.map(([id]) => id);

		for (const limit of [7, 100, 1000]) {
			const ids = await walkQuery(redis, { date: today, orgId: 'org-2', limit });
			expect(ids).toEqual(expected);
		}
		expect(await walkQuery(redis, { date: today, limit: 333 })).toEqual(all.map(([id]) => id));
	});

	it('caps the message index at MAXLEN entries and scans histories past the cap', async () => {
		const small = { ...config, deliveryLogMaxLen: 100 } as MtaConfig;
		await logDeliveryEvent(redis, event(0, { messageId: 'target' }), small);
		for (let i = 1; i < 1000; i++) await logDeliveryEvent(redis, event(i), small);
		await logDeliveryEvent(redis, event(1000, { messageId: 'target' }), small);

		expect(await redis.hlen(messageIndexKeyFor(today))).toBeLessThanOrEqual(100);
		expect(await redis.hget(statsKeyFor(today), 'msgIndexed')).toBe('100');
		const history = await getMessageEvents(redis, 'target');
		expect(history.map((e) => e.messageId)).toEqual(['target']);
	});

	it('keeps no index keys when the TTL is zero, like the stream itself', async () => {
		const noRetention = { ...config, deliveryLogTtlHours: 0 } as MtaConfig;
		await logDeliveryEvent(redis, event(0, { messageId: 'target' }), noRetention);
		expect(await redis.dbsize()).toBe(0);
		expect(await getMessageEvents(redis, 'target')).toEqual([]);
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

	it('trims and counts evictions of other organizations inside the same slot', async () => {
		const redis = fixture.client as unknown as Redis;
		await redis.del(
			streamKeyFor(today),
			statsKeyFor(today),
			messageIndexKeyFor(today),
			...[0, 1, 2].map((org) => orgStatsKeyFor(today, `org-${org}`))
		);
		const small = { ...config, deliveryLogMaxLen: 10 } as MtaConfig;
		for (let i = 0; i < 30; i++) await logDeliveryEvent(redis, event(i), small);

		expect(await redis.xlen(streamKeyFor(today))).toBe(10);
		const { coverage } = await readDayIndex(redis, today, 'stats');
		expect(coverage).toMatchObject({ kind: 'known', length: 10, entriesAdded: 30, evicted: 20 });
		for (const orgId of [undefined, 'org-0', 'org-2']) {
			expect(await getDeliveryLogStats(redis, today, orgId)).toMatchObject(
				await retainedCounts(redis, orgId)
			);
		}
	});
});
