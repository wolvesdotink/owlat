// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { usePostboxChunkWarmup, type ChunkLoader } from '../usePostboxChunkWarmup';

/** A synchronous scheduler so the warm-up body runs immediately. */
const runNow = (cb: () => void) => cb();
/** Loaders are dispatched in a microtask (fail-soft isolation); drain them. */
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe('usePostboxChunkWarmup', () => {
	it('invokes every loader once when warmed', async () => {
		const a: ChunkLoader = vi.fn(() => Promise.resolve());
		const b: ChunkLoader = vi.fn(() => Promise.resolve());
		const { warm } = usePostboxChunkWarmup({ loaders: [a, b], schedule: runNow });

		warm();
		await flush();

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('is idempotent — repeated warms do not re-load chunks', async () => {
		const loader: ChunkLoader = vi.fn(() => Promise.resolve());
		const { warm } = usePostboxChunkWarmup({ loaders: [loader], schedule: runNow });

		warm();
		warm();
		warm();
		await flush();

		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('defers work to the scheduler rather than running loaders eagerly', async () => {
		const loader: ChunkLoader = vi.fn(() => Promise.resolve());
		const scheduled: Array<() => void> = [];
		const schedule = (cb: () => void) => {
			scheduled.push(cb);
		};
		const { warm } = usePostboxChunkWarmup({ loaders: [loader], schedule });

		warm();
		// Scheduled but not yet run.
		expect(loader).not.toHaveBeenCalled();
		expect(scheduled).toHaveLength(1);

		scheduled[0]!();
		await flush();
		expect(loader).toHaveBeenCalledTimes(1);
	});

	it('is fail-soft: a throwing loader does not break the others', async () => {
		const bad: ChunkLoader = vi.fn(() => {
			throw new Error('chunk 404');
		});
		const good: ChunkLoader = vi.fn(() => Promise.resolve());
		const { warm } = usePostboxChunkWarmup({ loaders: [bad, good], schedule: runNow });

		expect(() => warm()).not.toThrow();
		await flush();
		expect(good).toHaveBeenCalledTimes(1);
	});

	it('swallows a rejected loader promise', async () => {
		const rejecting: ChunkLoader = vi.fn(() => Promise.reject(new Error('network')));
		const { warm } = usePostboxChunkWarmup({ loaders: [rejecting], schedule: runNow });

		warm();
		await flush();
		expect(rejecting).toHaveBeenCalledTimes(1);
	});
});
