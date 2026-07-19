import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeListenerSafely } from '../closeListenerSafely.js';

/**
 * Fix 1 (P2): a tolerated no-root deployment never binds the port-25 bounce
 * listener, so on SIGTERM `bounceServer.close()` REJECTS with
 * ERR_SERVER_NOT_RUNNING. The shutdown path must swallow that rejection — a bare
 * `bounceServer.close()` leaves it un-awaited, which surfaces as an unhandled
 * rejection and crashes the process mid-drain. `closeListenerSafely` is the
 * shared helper index.ts routes every SMTP-listener close through; these tests
 * pin its rejection-swallowing contract (index.ts itself is a non-exported
 * entrypoint that runs `main()` on import, so it can't be unit-imported).
 */
describe('closeListenerSafely', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('swallows an ERR_SERVER_NOT_RUNNING close rejection into a log line (no throw, no unhandled rejection)', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);

		const err = Object.assign(new Error('Server is not running.'), {
			code: 'ERR_SERVER_NOT_RUNNING',
		});
		const close = vi.fn(() => Promise.reject(err));
		const log = { error: vi.fn() };

		// Must NOT throw synchronously.
		expect(() => closeListenerSafely(close, 'Bounce server close failed', log)).not.toThrow();

		// Let the rejected promise settle and any unhandledRejection microtask flush.
		await new Promise((resolve) => setImmediate(resolve));

		expect(close).toHaveBeenCalledTimes(1);
		expect(log.error).toHaveBeenCalledWith({ err }, 'Bounce server close failed');
		expect(unhandled).not.toHaveBeenCalled();

		process.off('unhandledRejection', unhandled);
	});

	it('does not block the shutdown drain: an awaited step after the close still runs', async () => {
		// Model the shutdown ordering — the rejecting bounce close runs, then the
		// awaited worker drain proceeds to completion regardless.
		const order: string[] = [];
		const close = vi.fn(() =>
			Promise.reject(new Error('Server is not running.')).catch((e) => {
				order.push('close-rejected');
				throw e;
			})
		);
		const log = { error: vi.fn(() => order.push('close-logged')) };

		closeListenerSafely(close, 'Bounce server close failed', log);

		// The graceful drain that follows the close calls in index.ts.
		const drain = async () => {
			await new Promise((resolve) => setImmediate(resolve));
			order.push('worker-drained');
		};
		await drain();

		expect(order).toContain('worker-drained');
		expect(log.error).toHaveBeenCalledOnce();
	});

	it('a resolving close (listener was bound) never logs an error', async () => {
		const close = vi.fn(() => Promise.resolve());
		const log = { error: vi.fn() };

		closeListenerSafely(close, 'Submission server close failed', log);
		await new Promise((resolve) => setImmediate(resolve));

		expect(close).toHaveBeenCalledTimes(1);
		expect(log.error).not.toHaveBeenCalled();
	});
});
