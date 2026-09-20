import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import {
	classifyDelayedQueue,
	DELAYED_ORPHAN_SAMPLE_SIZE,
	DELAYED_OVERDUE_GRACE_MS,
	probeDelayedQueue,
	QUEUE_KEY_NAMESPACE,
} from '../delayedOrphans.js';

const DELAYED_KEY = `${QUEUE_KEY_NAMESPACE}:delayed`;
const NOW = 1_800_000_000_000;
const LONG_OVERDUE = NOW - DELAYED_OVERDUE_GRACE_MS - 60_000;

describe('classifyDelayedQueue', () => {
	it('says ok with nothing overdue', () => {
		expect(classifyDelayedQueue({ overdue: 0, sampled: 0, orphaned: 0 })).toBe('ok');
	});

	it('distinguishes a lagging promoter from a leak', () => {
		// Overdue but intact is a throughput problem that time can fix.
		expect(classifyDelayedQueue({ overdue: 5_000, sampled: 20, orphaned: 0 })).toBe('behind');
	});

	it('reports a leak on a single payload-less sighting', () => {
		expect(classifyDelayedQueue({ overdue: 5_000, sampled: 20, orphaned: 1 })).toBe('orphaned');
	});
});

describe('probeDelayedQueue', () => {
	let redis: Redis;

	beforeEach(async () => {
		redis = new RedisMock() as unknown as Redis;
		await redis.flushall();
	});

	/** A member with its payload intact, as a live scheduled retry has. */
	async function addScheduled(jobId: string, runAt: number) {
		await redis.zadd(DELAYED_KEY, String(runAt), jobId);
		await redis.hset(`${QUEUE_KEY_NAMESPACE}:job:${jobId}`, 'groupId', 'transactional:example.com');
	}

	/** A member whose payload is gone — yesterday's six million. */
	async function addOrphan(jobId: string, runAt: number) {
		await redis.zadd(DELAYED_KEY, String(runAt), jobId);
	}

	it('says ok on an empty delay set', async () => {
		expect(await probeDelayedQueue(redis, NOW)).toEqual({
			status: 'ok',
			delayed: 0,
			overdue: 0,
			sampled: 0,
			orphaned: 0,
		});
	});

	it('does not sample a set whose members are all still waiting', async () => {
		await addScheduled('future', NOW + 600_000);
		// The orphan is not due yet, so it is not yet evidence of anything.
		await addOrphan('future-orphan', NOW + 600_000);

		const probe = await probeDelayedQueue(redis, NOW);

		expect(probe.status).toBe('ok');
		expect(probe.delayed).toBe(2);
		expect(probe.sampled).toBe(0);
	});

	it('reports a lagging promoter without calling it a leak', async () => {
		await addScheduled('late-a', LONG_OVERDUE);
		await addScheduled('late-b', LONG_OVERDUE);

		const probe = await probeDelayedQueue(redis, NOW);

		expect(probe).toMatchObject({ status: 'behind', overdue: 2, sampled: 2, orphaned: 0 });
	});

	it('names an overdue member that has no message left to send', async () => {
		await addOrphan('stranded', LONG_OVERDUE);

		const probe = await probeDelayedQueue(redis, NOW);

		expect(probe).toMatchObject({ status: 'orphaned', overdue: 1, sampled: 1, orphaned: 1 });
	});

	it('inspects a bounded sample however deep the backlog is', async () => {
		for (let i = 0; i < DELAYED_ORPHAN_SAMPLE_SIZE * 5; i++) {
			await addOrphan(`stranded-${i}`, LONG_OVERDUE + i);
		}

		const probe = await probeDelayedQueue(redis, NOW);

		expect(probe.status).toBe('orphaned');
		expect(probe.overdue).toBe(DELAYED_ORPHAN_SAMPLE_SIZE * 5);
		expect(probe.sampled).toBe(DELAYED_ORPHAN_SAMPLE_SIZE);
	});

	it('reports unknown rather than throwing when Redis cannot be read', async () => {
		const broken = {
			zcard: () => Promise.reject(new Error('redis down')),
		} as unknown as Redis;

		expect(await probeDelayedQueue(broken, NOW)).toMatchObject({ status: 'unknown' });
	});
});
