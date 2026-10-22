/**
 * The worker's backoff for a handler error the handler did not expect. Deferrals
 * re-enqueue themselves with their own delay; this curve only governs throws.
 */
import { describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';

// groupmq's Worker opens real Redis machinery on construction; the options it
// is handed are all this test reads.
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

const { createEmailWorker, unexpectedErrorBackoffMs } = await import('../setup.js');

describe('unexpected handler error backoff', () => {
	it('waits 2, 8 and 32 minutes after the first three failed runs, then 2 h', () => {
		expect([1, 2, 3, 4, 5].map(unexpectedErrorBackoffMs)).toEqual([
			120_000, 480_000, 1_920_000, 7_200_000, 7_200_000,
		]);
		expect(unexpectedErrorBackoffMs(0)).toBe(30_000);
	});

	it('is the backoff the worker is created with', () => {
		const redis = new Redis() as unknown as import('ioredis').default;
		const config = { workerConcurrency: 1, serverId: 'mta-1' } as never;
		const { worker, stopHeartbeat } = createEmailWorker({} as never, redis, config);
		stopHeartbeat();
		const { backoff } = (worker as unknown as { options: { backoff: (n: number) => number } })
			.options;
		expect(backoff).toBe(unexpectedErrorBackoffMs);
	});
});
