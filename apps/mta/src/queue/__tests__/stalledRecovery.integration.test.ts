/**
 * A job whose worker died mid-run must come back, on real Redis with the real
 * (patched) GroupMQ Lua.
 *
 * A killed worker leaves its job in `:processing` with a deadline nobody
 * renews, and its id in the group's `:active` list, which every reserve script
 * gates on. `patches/groupmq@1.1.0.patch` turns off the reclamation in the
 * cleanup timer and both reserve scripts, because it requeued the job without
 * releasing that list and wedged the group for good; check-stalled.lua is the
 * one path left, and
 * `MAX_STALLED_COUNT` bounds it. scripts/kill-tests exercises the same path by
 * SIGKILLing the MTA container; this suite pins the queue half of it.
 */

import type { Queue } from 'groupmq';
import type Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dockerRedisAvailable } from '../../__tests__/helpers/redisCluster.js';
import {
	startRedisStandaloneFixture,
	stopRedisStandaloneFixture,
	type RedisStandaloneFixture,
} from '../../__tests__/helpers/redisStandalone.js';
import type { EmailJob } from '../../types.js';
import { QUEUE_KEY_NAMESPACE } from '../namespace.js';
import { createEmailQueue, MAX_STALLED_COUNT } from '../setup.js';

const GROUP = 'transactional:example.com';

function emailJob(messageId: string): EmailJob {
	return {
		messageId,
		to: 'rcpt@example.com',
		from: 'sender@example.com',
		subject: 'stall',
		html: '<p>stall</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'example.com',
	} as EmailJob;
}

describe.runIf(dockerRedisAvailable())('stalled job recovery on standalone Redis', () => {
	let fixture: RedisStandaloneFixture;
	let redis: Redis;
	let queue: Queue<EmailJob>;

	beforeAll(async () => {
		fixture = await startRedisStandaloneFixture('stalled');
		redis = fixture.client;
	});

	afterAll(async () => {
		await stopRedisStandaloneFixture(fixture);
	});

	beforeEach(async () => {
		await redis.flushall();
		queue = createEmailQueue(redis);
	});

	/** What a worker that reserved `jobId` and was then killed leaves behind. */
	async function abandonReservation(jobId: string): Promise<void> {
		const reserved = await queue.reserve();
		expect(reserved?.id).toBe(jobId);
		const expired = Date.now() - 60_000;
		await redis.zadd(`${QUEUE_KEY_NAMESPACE}:processing`, expired, jobId);
		await redis.hset(`${QUEUE_KEY_NAMESPACE}:processing:${jobId}`, 'deadlineAt', String(expired));
	}

	it('leaves an expired job to check-stalled, which releases its group', async () => {
		await queue.add({ groupId: GROUP, data: emailJob('m-1'), jobId: 'm-1' });
		await queue.add({ groupId: GROUP, data: emailJob('m-2'), jobId: 'm-2' });
		await abandonReservation('m-1');

		// The cleanup timer and the reserve loop reach the expired job first: none
		// of them may take it half-way out. Dropping `stalled:lastcheck` is what
		// made the upstream reserve scripts run their own reclamation.
		await queue.cleanup();
		await redis.del(`${QUEUE_KEY_NAMESPACE}:stalled:lastcheck`);
		expect(await queue.reserve()).toBeNull();
		await redis.del(`${QUEUE_KEY_NAMESPACE}:stalled:lastcheck`);
		expect(await queue.reserveBatch(8)).toEqual([]);
		expect(await redis.zscore(`${QUEUE_KEY_NAMESPACE}:processing`, 'm-1')).not.toBeNull();

		expect(await queue.checkStalledJobs(Date.now(), 0, MAX_STALLED_COUNT)).toEqual([
			'm-1',
			GROUP,
			'recovered',
		]);
		expect(await redis.lrange(`${QUEUE_KEY_NAMESPACE}:g:${GROUP}:active`, 0, -1)).toEqual([]);
		const rerun = await queue.reserve();
		expect(rerun?.id).toBe('m-1');
		expect(rerun?.data.messageId).toBe('m-1');
	});

	it('re-queues a job that keeps killing its worker until the stall cap, then fails it', async () => {
		await queue.add({ groupId: GROUP, data: emailJob('m-loop'), jobId: 'm-loop' });
		const actions: string[] = [];
		for (let stall = 1; stall <= MAX_STALLED_COUNT; stall++) {
			await abandonReservation('m-loop');
			// check-stalled.lua skips a run within 2 s of the previous one; the
			// worker's checks are 30 s apart, so drop that guard between stalls.
			await redis.del(`${QUEUE_KEY_NAMESPACE}:stalled:circuit`);
			const result = await queue.checkStalledJobs(Date.now(), 0, MAX_STALLED_COUNT);
			actions.push(result[2] ?? 'none');
		}
		expect(actions).toEqual([
			...Array.from({ length: MAX_STALLED_COUNT - 1 }, () => 'recovered'),
			'failed',
		]);
		expect(await redis.hget(`${QUEUE_KEY_NAMESPACE}:job:m-loop`, 'status')).toBe('failed');
		expect(await queue.reserve()).toBeNull();
	});
});
