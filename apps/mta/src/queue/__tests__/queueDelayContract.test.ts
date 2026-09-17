/**
 * Two properties of the queue the MTA's defer ladder rests on, pinned against
 * the real GroupMQ code rather than a stand-in for it.
 *
 * 1. A job scheduled for later does not run earlier. The MTA never throws a
 *    defer back at the worker — it enqueues a successor with the computed
 *    delay and completes — so if the queue hands that successor straight back
 *    on completion, the whole retry ladder runs at handler speed instead of at
 *    the per-category delay, and every rung it skips past leaves its entry in
 *    the `:delayed` ZSET with nothing left to remove it. That is how one
 *    message reached six million delayed entries and 3.9 GB of Redis.
 *
 * 2. The promoter can always let go of a member. A `:delayed` entry whose job
 *    hash has been trimmed or deleted has no payload left to deliver, so the
 *    only question is whether anything can still remove the entry. Upstream's
 *    bulk `promote-delayed-jobs` could not — it asked for the group id first
 *    and skipped the `ZREM` when the hash was gone — which is precisely the
 *    six-million-member state that had to be cleared by hand.
 *
 * 3. A Redis restart does not wedge the queue. GroupMQ memoises each script's
 *    SHA per client object and only ever calls EVALSHA, so once the server
 *    forgets the script every queue operation fails NOSCRIPT for good.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import { Queue } from 'groupmq';
import {
	withLuaScripting,
	type ScriptedRedisMock,
} from '../../__tests__/helpers/luaScriptedRedisMock.js';
import { withScriptCacheRecovery } from '../../lib/redisScriptCache.js';

const NAMESPACE = 'delay-contract';
const DELAYED_KEY = `groupmq:${NAMESPACE}:delayed`;
const GROUP = 'transactional:example.com';

interface Payload {
	rung: number;
}

function jobStatusKey(jobId: string): string {
	return `groupmq:${NAMESPACE}:job:${jobId}`;
}

function completionMeta() {
	const now = Date.now();
	return { processedOn: now, finishedOn: now, attempts: 0, maxAttempts: 5 };
}

describe('queue delay contract', () => {
	let redis: InstanceType<typeof RedisMock>;
	let server: ScriptedRedisMock;
	let queue: Queue<Payload>;

	beforeEach(async () => {
		redis = new RedisMock();
		await redis.flushall();
		server = withLuaScripting(redis);
		queue = new Queue<Payload>({
			redis: withScriptCacheRecovery(redis as never),
			namespace: NAMESPACE,
			jobTimeoutMs: 120_000,
			maxAttempts: 5,
			keepCompleted: 1000,
			keepFailed: 5000,
		});
	});

	/** Enqueue a root job and take it as the worker would. */
	async function reserveRoot(jobId = 'root') {
		await queue.add({ groupId: GROUP, data: { rung: 0 }, jobId });
		const reserved = await queue.reserve();
		expect(reserved?.id).toBe(jobId);
		return jobId;
	}

	it('does not hand a deferred successor back before its delay elapses', async () => {
		const root = await reserveRoot();
		// What `handoffDeferredJob` does: commit the successor, then complete.
		await queue.add({ groupId: GROUP, data: { rung: 1 }, jobId: 'successor', delay: 60_000 });

		const chained = await queue.completeAndReserveNextWithMetadata(
			root,
			GROUP,
			null,
			completionMeta()
		);

		expect(chained).toBeNull();
		// Only the chaining is skipped: the completing job still completes, so
		// this is a queue that waits rather than a queue that stalls.
		expect(await redis.hget(jobStatusKey(root), 'status')).toBe('completed');
		// Still scheduled, and still the promoter's to release — a job popped
		// early would leave this entry behind with no owner.
		expect(await redis.zrange(DELAYED_KEY, 0, -1)).toEqual(['successor']);
		expect(await redis.hget(jobStatusKey('successor'), 'status')).toBe('delayed');
	});

	it('still chains a successor that is due now', async () => {
		const root = await reserveRoot();
		await queue.add({ groupId: GROUP, data: { rung: 1 }, jobId: 'successor' });

		const chained = await queue.completeAndReserveNextWithMetadata(
			root,
			GROUP,
			null,
			completionMeta()
		);

		expect(chained?.id).toBe('successor');
		expect(await redis.zrange(DELAYED_KEY, 0, -1)).toEqual([]);
	});

	it('cannot run a defer ladder faster than its delays', async () => {
		let current = await reserveRoot();

		// Each rung commits its successor and completes, exactly as the dispatch
		// handler does. With the delay honoured the ladder stops after one rung
		// and waits for the promoter; without it, this loop is the 1000-per-
		// second runaway that filled Redis.
		for (let rung = 1; rung <= 5; rung++) {
			await queue.add({
				groupId: GROUP,
				data: { rung },
				jobId: `rung-${rung}`,
				delay: 60_000,
			});
			const chained = await queue.completeAndReserveNextWithMetadata(
				current,
				GROUP,
				null,
				completionMeta()
			);
			if (!chained) break;
			current = chained.id;
		}

		expect(await redis.zrange(DELAYED_KEY, 0, -1)).toEqual(['rung-1']);
	});

	/** Leave a `:delayed` member behind with its payload already gone. */
	async function orphanDelayedMember(jobId: string, dueAt: number) {
		await queue.add({ groupId: GROUP, data: { rung: 1 }, jobId, delay: 60_000 });
		await redis.del(jobStatusKey(jobId));
		await redis.del(`groupmq:${NAMESPACE}:job:${jobId}:data`);
		await redis.zadd(DELAYED_KEY, String(dueAt), jobId);
	}

	it('drains a due member whose job hash is gone', async () => {
		await orphanDelayedMember('orphan', Date.now() - 1_000);

		expect(await queue.promoteDelayedJobs()).toBe(1);

		// Nothing else in the system can remove this entry: the job it names has
		// no payload, so it will never be reserved, run, completed or trimmed.
		expect(await redis.zrange(DELAYED_KEY, 0, -1)).toEqual([]);
	});

	it('still promotes a due member that has its payload', async () => {
		await queue.add({ groupId: GROUP, data: { rung: 1 }, jobId: 'real', delay: 60_000 });
		await redis.zadd(DELAYED_KEY, String(Date.now() - 1_000), 'real');

		expect(await queue.promoteDelayedJobs()).toBe(1);

		expect(await redis.zrange(DELAYED_KEY, 0, -1)).toEqual([]);
		expect(await redis.zrange(`groupmq:${NAMESPACE}:ready`, 0, -1)).toEqual([GROUP]);
	});

	it('leaves a member that is not due yet alone, payload or not', async () => {
		// The bound that makes dropping safe: only an entry the promoter was
		// about to release anyway is released. A future rung is untouched.
		await orphanDelayedMember('not-due', Date.now() + 600_000);

		expect(await queue.promoteDelayedJobs()).toBe(0);

		expect(await redis.zrange(DELAYED_KEY, 0, -1)).toEqual(['not-due']);
	});

	it('keeps enqueuing after a restart empties the script cache', async () => {
		await queue.add({ groupId: GROUP, data: { rung: 0 }, jobId: 'before-restart' });

		server.restart();

		await queue.add({ groupId: GROUP, data: { rung: 1 }, jobId: 'after-restart' });
		expect(await redis.hget(jobStatusKey('after-restart'), 'id')).toBe('after-restart');
	});

	it('wedges on NOSCRIPT without the recovery — the failure this guards', async () => {
		const bare = new RedisMock();
		const bareServer = withLuaScripting(bare);
		const bareQueue = new Queue<Payload>({
			redis: bare as never,
			namespace: NAMESPACE,
			maxAttempts: 5,
		});
		await bareQueue.add({ groupId: GROUP, data: { rung: 0 }, jobId: 'before-restart' });

		bareServer.restart();

		await expect(
			bareQueue.add({ groupId: GROUP, data: { rung: 1 }, jobId: 'after-restart' })
		).rejects.toThrow('NOSCRIPT');
	});
});
