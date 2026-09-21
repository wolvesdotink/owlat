/**
 * The per-domain scan is the read an operator makes during an incident, so the
 * things it must not do are: miss a group, mis-count a backlog, or hand back a
 * listing ordered by which group happened to come first out of `SMEMBERS`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { Queue } from 'groupmq';
import type Redis from 'ioredis';
import { withLuaScripting } from '../../__tests__/helpers/luaScriptedRedisMock.js';
import { QUEUE_NAMESPACE } from '../namespace.js';
import { readDelayedRunAt, scanWaitingByDomain } from '../inspect.js';

let redis: InstanceType<typeof RedisMock>;
let queue: Queue<{ n: number }>;

async function add(jobId: string, groupId: string, opts: { delay?: number } = {}): Promise<void> {
	await queue.add({
		groupId,
		data: { n: 1 },
		jobId,
		...(opts.delay === undefined ? {} : { delay: opts.delay }),
	});
}

beforeEach(async () => {
	redis = new RedisMock();
	await redis.flushall();
	withLuaScripting(redis);
	queue = new Queue<{ n: number }>({
		redis: redis as never,
		namespace: QUEUE_NAMESPACE,
		jobTimeoutMs: 120_000,
		maxAttempts: 5,
	});
});

describe('scanWaitingByDomain', () => {
	it('spans every ip pool sending to the domain', async () => {
		await add('t-1', 'transactional:acme.test');
		await add('c-1', 'campaign:acme.test');
		await add('elsewhere', 'transactional:other.test');

		const scan = await scanWaitingByDomain(redis as unknown as Redis, 'acme.test', 50);

		expect(scan.jobIds.sort()).toEqual(['c-1', 't-1']);
		expect(scan.waiting).toBe(2);
		expect(scan.groups).toBe(2);
	});

	it('counts the whole backlog while listing only `limit` of it', async () => {
		for (let i = 0; i < 30; i++) await add(`job-${i}`, 'transactional:acme.test');

		const scan = await scanWaitingByDomain(redis as unknown as Redis, 'acme.test', 5);

		// The count is what the operator asked about; the listing is what fits.
		expect(scan.waiting).toBe(30);
		expect(scan.jobIds).toHaveLength(5);
	});

	it("orders the listing by GroupMQ's own FIFO score, not by group", async () => {
		// Interleaved across two pools: merging per group would put all of one
		// pool's jobs ahead of the other's and call it "the head of the queue".
		await add('first', 'transactional:acme.test');
		await add('second', 'campaign:acme.test');
		await add('third', 'transactional:acme.test');

		const scan = await scanWaitingByDomain(redis as unknown as Redis, 'acme.test', 2);

		expect(scan.jobIds).toEqual(['first', 'second']);
	});

	it('matches the domain case-insensitively and does not match a suffix of it', async () => {
		await add('wanted', 'transactional:acme.test');
		await add('decoy', 'transactional:not-acme.test');

		const scan = await scanWaitingByDomain(redis as unknown as Redis, 'ACME.test', 50);

		expect(scan.jobIds).toEqual(['wanted']);
	});

	it('says nothing is queued only when nothing is', async () => {
		await add('elsewhere', 'transactional:other.test');

		const scan = await scanWaitingByDomain(redis as unknown as Redis, 'acme.test', 50);

		expect(scan).toEqual({ jobIds: [], waiting: 0, groups: 0 });
	});
});

describe('readDelayedRunAt', () => {
	it('reads the release time of a job on the retry ladder', async () => {
		const before = Date.now();
		await add('later', 'transactional:acme.test', { delay: 60_000 });

		const runAt = await readDelayedRunAt(redis as unknown as Redis, 'later');

		expect(runAt).toBeGreaterThanOrEqual(before + 60_000);
	});

	it('still reads it once the job is overdue', async () => {
		// The state `Job.opts.delay` cannot express.
		await add('stuck', 'transactional:acme.test', { delay: 60_000 });
		const past = Date.now() - 3_600_000;
		await redis.zadd(`groupmq:${QUEUE_NAMESPACE}:delayed`, String(past), 'stuck');

		expect(await readDelayedRunAt(redis as unknown as Redis, 'stuck')).toBe(past);
	});

	it('is null for a job that is not delayed', async () => {
		await add('now', 'transactional:acme.test');

		expect(await readDelayedRunAt(redis as unknown as Redis, 'now')).toBeNull();
	});
});
