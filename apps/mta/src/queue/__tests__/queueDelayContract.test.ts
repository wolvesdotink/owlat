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
 * 2. A Redis restart does not wedge the queue. GroupMQ memoises each script's
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
