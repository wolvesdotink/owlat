/**
 * Worker liveness must be a property of the worker RUNNING, not of it having
 * processed a job — otherwise a fresh, idle install reports a dead worker
 * forever (and the release e2e-install gate, which polls /health for
 * `worker.alive`, can never pass).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis-mock';

// groupmq's Worker/Queue open real Redis machinery on construction; the
// heartbeat contract is independent of them, so stub the module.
vi.mock('groupmq', () => ({
	Queue: class {
		constructor(public options: unknown) {}
	},
	Worker: class {
		constructor(public options: unknown) {}
		on() {
			return this;
		}
	},
}));

const { createEmailWorker, startWorkerHeartbeat } = await import('../setup.js');
const { WORKER_HEARTBEAT_INTERVAL_MS } = await import('../../routes/health.js');

const HEARTBEAT_KEY = 'mta:worker:heartbeat';
const SERVER_ID = 'mta-1';

function makeRedis() {
	return new Redis() as unknown as import('ioredis').default;
}

describe('worker heartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('beats immediately on start, before any job is processed', async () => {
		const redis = makeRedis();

		const stop = startWorkerHeartbeat(redis, SERVER_ID);
		await vi.advanceTimersByTimeAsync(0);

		const beat = await redis.hget(HEARTBEAT_KEY, SERVER_ID);
		expect(beat).not.toBeNull();
		expect(Number(beat)).toBe(Date.now());
		expect(await redis.ttl(HEARTBEAT_KEY)).toBeGreaterThan(0);

		stop();
	});

	it('refreshes the beat on the interval while idle', async () => {
		const redis = makeRedis();

		const stop = startWorkerHeartbeat(redis, SERVER_ID);
		await vi.advanceTimersByTimeAsync(0);
		const first = Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID));

		await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
		const second = Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID));
		expect(second).toBe(first + WORKER_HEARTBEAT_INTERVAL_MS);

		await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
		const third = Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID));
		expect(third).toBe(second + WORKER_HEARTBEAT_INTERVAL_MS);

		stop();
	});

	it('refreshes well within the freshness window', async () => {
		const { WORKER_HEARTBEAT_TTL } = await import('../../routes/health.js');
		expect(WORKER_HEARTBEAT_INTERVAL_MS).toBe((WORKER_HEARTBEAT_TTL / 4) * 1_000);
	});

	it('stops beating once teardown clears the timer', async () => {
		const redis = makeRedis();

		const stop = startWorkerHeartbeat(redis, SERVER_ID);
		await vi.advanceTimersByTimeAsync(0);
		const lastBeat = Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID));

		stop();
		await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 5);

		expect(Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID))).toBe(lastBeat);
	});

	it('survives a failing redis write and keeps beating', async () => {
		const redis = makeRedis();
		const hset = vi
			.spyOn(redis, 'hset')
			.mockRejectedValueOnce(new Error('redis down') as never) as unknown as {
			mock: { calls: unknown[] };
		};

		const stop = startWorkerHeartbeat(redis, SERVER_ID);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);

		expect(hset.mock.calls.length).toBe(2);
		expect(await redis.hget(HEARTBEAT_KEY, SERVER_ID)).not.toBeNull();

		stop();
	});

	it('createEmailWorker heartbeats at creation and hands back a stopper', async () => {
		const redis = makeRedis();
		const queue = {} as never;
		const config = { workerConcurrency: 2, serverId: SERVER_ID } as never;

		const { worker, stopHeartbeat } = createEmailWorker(queue, redis, config);
		await vi.advanceTimersByTimeAsync(0);

		expect(worker).toBeDefined();
		const atCreation = Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID));
		expect(atCreation).toBe(Date.now());

		await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS);
		expect(Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID))).toBeGreaterThan(atCreation);

		stopHeartbeat();
		await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_INTERVAL_MS * 3);
		expect(Number(await redis.hget(HEARTBEAT_KEY, SERVER_ID))).toBe(
			atCreation + WORKER_HEARTBEAT_INTERVAL_MS
		);
	});
});
