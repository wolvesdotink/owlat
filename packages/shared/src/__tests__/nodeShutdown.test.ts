import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	installCrashHandlers,
	installShutdown,
	type ShutdownHandle,
	type ShutdownOptions,
} from '../nodeShutdown';

/**
 * Both helpers register process-wide listeners. Every test installs on a
 * throwaway signal name (or removes what it added) so one test's handler can
 * never fire during another's — and so a stray listener cannot outlive the file
 * and take down the vitest worker on a real SIGINT.
 */
const installed: { event: string; count: number }[] = [];

afterEach(() => {
	for (const { event } of installed) {
		for (const listener of process.listeners(event as NodeJS.Signals).slice(-2)) {
			process.off(event, listener);
		}
	}
	installed.length = 0;
	vi.useRealTimers();
});

let nextSignal = 0;
/** A signal name Node will happily register a listener for but never deliver. */
function scratchSignal(): NodeJS.Signals {
	// SIGUSR2 is reserved by some tooling; SIGWINCH is inert in CI and locally.
	const event = (nextSignal++ % 2 === 0 ? 'SIGWINCH' : 'SIGCONT') as NodeJS.Signals;
	installed.push({ event, count: 1 });
	return event;
}

function install(
	options: Partial<ShutdownOptions> & { exit: (code: number) => void }
): ShutdownHandle {
	return installShutdown({
		timeoutMs: 1_000,
		log: () => {},
		signals: [scratchSignal()],
		...options,
	});
}

describe('installShutdown', () => {
	/** A server that answers `close()` the way node:http does: on a callback. */
	function fakeServer() {
		let finish!: (err?: Error) => void;
		const close = vi.fn((cb?: (err?: Error) => void) => {
			finish = cb ?? (() => {});
		});
		const closeIdleConnections = vi.fn();
		return {
			server: { close, closeIdleConnections },
			close,
			closeIdleConnections,
			/** Pretend the last in-flight response finished writing. */
			finishResponses: (err?: Error) => finish(err),
		};
	}

	it('closes the server and exits 0 when nothing is in flight', async () => {
		const exit = vi.fn();
		const fake = fakeServer();
		const handle = install({ exit, server: fake.server });

		const shutting = handle.shutdown('SIGTERM');
		fake.finishResponses();
		await shutting;

		expect(fake.close).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(0);
	});

	/**
	 * `close()` resolves only once the last response has been written. Exiting on
	 * the call rather than the callback truncates whatever a client is mid-read
	 * of — which is the failure this whole module exists to stop.
	 */
	it('waits for in-flight responses to finish writing before exiting', async () => {
		const exit = vi.fn();
		const fake = fakeServer();
		const handle = install({ exit, server: fake.server });

		const shutting = handle.shutdown('SIGTERM');
		await Promise.resolve();
		expect(exit).not.toHaveBeenCalled();

		fake.finishResponses();
		await shutting;
		expect(exit).toHaveBeenCalledWith(0);
	});

	it('cuts idle keep-alive sockets so they cannot hold the close open', async () => {
		const exit = vi.fn();
		const fake = fakeServer();
		const handle = install({ exit, server: fake.server });

		const shutting = handle.shutdown('SIGTERM');
		expect(fake.closeIdleConnections).toHaveBeenCalledOnce();

		fake.finishResponses();
		await shutting;
	});

	it('exits 0 when close reports an error rather than hanging on it', async () => {
		const exit = vi.fn();
		const fake = fakeServer();
		const handle = install({ exit, server: fake.server });

		const shutting = handle.shutdown('SIGTERM');
		fake.finishResponses(new Error('not running'));
		await shutting;

		expect(exit).toHaveBeenCalledWith(0);
	});

	it('waits for an in-flight critical section before exiting', async () => {
		const exit = vi.fn();
		const order: string[] = [];
		const handle = install({ exit });

		let release!: () => void;
		const section = handle.critical(
			() =>
				new Promise<void>((resolve) => {
					release = () => {
						order.push('section finished');
						resolve();
					};
				})
		);

		const shutting = handle.shutdown('SIGTERM').then(() => order.push('exited'));
		await Promise.resolve();
		expect(exit).not.toHaveBeenCalled();

		release();
		await section;
		await shutting;

		expect(order).toEqual(['section finished', 'exited']);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it('waits for a section that another section started', async () => {
		const exit = vi.fn();
		const handle = install({ exit });
		const done: string[] = [];

		let releaseInner!: () => void;
		const outer = handle.critical(async () => {
			done.push('outer:start');
			await handle.critical(
				() =>
					new Promise<void>((resolve) => {
						releaseInner = resolve;
					})
			);
			done.push('outer:end');
		});

		const shutting = handle.shutdown('SIGTERM');
		await Promise.resolve();
		releaseInner();
		await outer;
		await shutting;

		expect(done).toEqual(['outer:start', 'outer:end']);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it('a rejecting critical section does not stall or break the drain', async () => {
		const exit = vi.fn();
		const handle = install({ exit });

		const section = handle.critical(() => Promise.reject(new Error('boom')));
		await expect(section).rejects.toThrow('boom');
		await handle.shutdown('SIGTERM');

		expect(exit).toHaveBeenCalledWith(0);
	});

	it('runs drain after the in-flight work, and exits 0 even if drain throws', async () => {
		const exit = vi.fn();
		const order: string[] = [];
		const handle = install({
			exit,
			drain: async () => {
				order.push('drain');
				throw new Error('drain failed');
			},
		});

		await handle.critical(async () => {
			order.push('section');
		});
		await handle.shutdown('SIGTERM');

		expect(order).toEqual(['section', 'drain']);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it('hard-exits 1 when a response never finishes writing', async () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const fake = fakeServer();
		const handle = install({ exit, server: fake.server, timeoutMs: 5_000 });

		void handle.shutdown('SIGTERM');
		await Promise.resolve();
		expect(exit).not.toHaveBeenCalled();

		vi.advanceTimersByTime(5_000);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it('hard-exits 1 when the drain outlives the deadline', async () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const handle = install({ exit, timeoutMs: 5_000 });

		handle.critical(() => new Promise<void>(() => {}));
		void handle.shutdown('SIGTERM');
		await Promise.resolve();

		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(5_000);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it('ignores a duplicate signal instead of closing twice', async () => {
		const exit = vi.fn();
		const fake = fakeServer();
		const handle = install({ exit, server: fake.server });

		const shutting = handle.shutdown('SIGTERM');
		fake.finishResponses();
		await shutting;
		await handle.shutdown('SIGINT');

		expect(fake.close).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it('reports isShuttingDown from the moment a signal is taken', async () => {
		const handle = install({ exit: () => {} });
		expect(handle.isShuttingDown()).toBe(false);
		await handle.shutdown('SIGTERM');
		expect(handle.isShuttingDown()).toBe(true);
	});

	it('drains even when the server throws instead of closing', async () => {
		const exit = vi.fn();
		const drain = vi.fn(async () => {});
		const handle = install({
			exit,
			drain,
			server: {
				close() {
					throw new Error('not running');
				},
			},
		});

		await handle.shutdown('SIGTERM');

		expect(drain).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledWith(0);
	});
});

describe('installCrashHandlers', () => {
	it('logs and exits 1 on both crash channels', () => {
		const exit = vi.fn();
		const log = vi.fn();
		const before = {
			uncaught: process.listeners('uncaughtException').length,
			rejection: process.listeners('unhandledRejection').length,
		};

		installCrashHandlers({ log, exit });

		const uncaught = process.listeners('uncaughtException').at(-1)!;
		const rejection = process.listeners('unhandledRejection').at(-1)!;
		try {
			const err = new Error('thrown');
			(uncaught as (e: Error) => void)(err);
			(rejection as (r: unknown) => void)('rejected');

			expect(exit).toHaveBeenNthCalledWith(1, 1);
			expect(exit).toHaveBeenNthCalledWith(2, 1);
			expect(log).toHaveBeenNthCalledWith(1, expect.stringContaining('uncaught exception'), err);
			expect(log).toHaveBeenNthCalledWith(
				2,
				expect.stringContaining('unhandled rejection'),
				'rejected'
			);
		} finally {
			process.off('uncaughtException', uncaught);
			process.off('unhandledRejection', rejection);
			expect(process.listeners('uncaughtException').length).toBe(before.uncaught);
			expect(process.listeners('unhandledRejection').length).toBe(before.rejection);
		}
	});
});
