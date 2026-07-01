import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutoRecheckPoller } from '../domainAutoRecheck';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Flush the microtask queue so a resolved onTick promise settles. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('createAutoRecheckPoller', () => {
	it('does not tick until the first interval elapses', async () => {
		const onTick = vi.fn(async () => false);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000 });
		poller.start();
		expect(onTick).not.toHaveBeenCalled();
		expect(poller.isRunning()).toBe(true);
		poller.stop();
	});

	it('ticks on each interval while not yet verified', async () => {
		const onTick = vi.fn(async () => false);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000 });
		poller.start();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(onTick).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(onTick).toHaveBeenCalledTimes(2);
		poller.stop();
	});

	it('stops as soon as onTick reports done (verified)', async () => {
		const onTick = vi
			.fn<[], Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000 });
		poller.start();

		await vi.advanceTimersByTimeAsync(30_000);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(poller.isRunning()).toBe(false);

		// No further ticks after it stopped.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onTick).toHaveBeenCalledTimes(2);
	});

	it('stops after the attempt cap even if never verified', async () => {
		const onTick = vi.fn(async () => false);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000, maxAttempts: 3 });
		poller.start();

		await vi.advanceTimersByTimeAsync(30_000 * 5);
		expect(onTick).toHaveBeenCalledTimes(3);
		expect(poller.isRunning()).toBe(false);
	});

	it('never overlaps: skips a beat while a slow tick is still in flight', async () => {
		let resolve!: (v: boolean) => void;
		const onTick = vi.fn(
			() =>
				new Promise<boolean>((r) => {
					resolve = r;
				}),
		);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000 });
		poller.start();

		await vi.advanceTimersByTimeAsync(30_000); // tick 1 starts, stays pending
		expect(onTick).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000); // beat skipped — still in flight
		expect(onTick).toHaveBeenCalledTimes(1);

		resolve(false); // tick 1 settles
		await flush();
		await vi.advanceTimersByTimeAsync(30_000); // now free to run again
		expect(onTick).toHaveBeenCalledTimes(2);
		poller.stop();
	});

	it('fails soft: a rejecting onTick reports via onError and keeps polling', async () => {
		const onError = vi.fn();
		const onTick = vi
			.fn<[], Promise<boolean>>()
			.mockRejectedValueOnce(new Error('DoH down'))
			.mockResolvedValue(false);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000, onError });
		poller.start();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(poller.isRunning()).toBe(true);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(onTick).toHaveBeenCalledTimes(2);
		poller.stop();
	});

	it('start() is idempotent — does not stack intervals', async () => {
		const onTick = vi.fn(async () => false);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000 });
		poller.start();
		poller.start();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(onTick).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it('stop() halts all further ticks', async () => {
		const onTick = vi.fn(async () => false);
		const poller = createAutoRecheckPoller({ onTick, intervalMs: 30_000 });
		poller.start();
		poller.stop();

		await vi.advanceTimersByTimeAsync(120_000);
		expect(onTick).not.toHaveBeenCalled();
		expect(poller.isRunning()).toBe(false);
	});
});
