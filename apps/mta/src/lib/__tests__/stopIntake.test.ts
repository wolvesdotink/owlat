import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdown, type ClosableServer } from '@owlat/shared/nodeShutdown';
import { stopIntake } from '../stopIntake.js';

/**
 * The MTA's intake stops (crons, heartbeat, SMTP listeners) must run when the
 * signal lands, not after the HTTP server's `close()` callback: that callback
 * waits for every open HTTP connection, and `drain` waits for the callback.
 */
describe('stopIntake', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function handles() {
		const interval = setInterval(() => {}, 60_000);
		const stopHeartbeat = vi.fn();
		const listener = { close: vi.fn(() => Promise.resolve()) };
		const log = { error: vi.fn() };
		return { interval, stopHeartbeat, listener, log };
	}

	it('clears every interval, runs every stop and closes the bound listeners', () => {
		const clear = vi.spyOn(globalThis, 'clearInterval');
		const { interval, stopHeartbeat, listener, log } = handles();

		stopIntake({
			intervals: [interval],
			stops: [stopHeartbeat],
			listeners: [
				[listener, 'Bounce server close failed'],
				[undefined, 'Submission server close failed'],
			],
			log,
		});

		expect(clear).toHaveBeenCalledWith(interval);
		expect(stopHeartbeat).toHaveBeenCalledTimes(1);
		expect(listener.close).toHaveBeenCalledTimes(1);
	});

	it('runs at the signal, while an open HTTP connection still holds close() and the drain', async () => {
		const clear = vi.spyOn(globalThis, 'clearInterval');
		const { interval, stopHeartbeat, listener, log } = handles();

		// A server with one long-lived connection: close() answers only on release.
		let releaseClose!: () => void;
		const server: ClosableServer = {
			close: (callback) => {
				releaseClose = () => callback?.();
			},
		};
		const drain = vi.fn(async () => {});
		const exit = vi.fn();

		const handle = installShutdown({
			server,
			onShutdown: () =>
				stopIntake({
					intervals: [interval],
					stops: [stopHeartbeat],
					listeners: [[listener, 'Bounce server close failed']],
					log,
				}),
			drain,
			timeoutMs: 5_000,
			log: () => {},
			exit,
			signals: [],
		});

		const done = handle.shutdown('SIGTERM');
		await new Promise((resolve) => setImmediate(resolve));

		expect(clear).toHaveBeenCalledWith(interval);
		expect(stopHeartbeat).toHaveBeenCalledTimes(1);
		expect(listener.close).toHaveBeenCalledTimes(1);
		expect(drain).not.toHaveBeenCalled();

		releaseClose();
		await done;
		expect(drain).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
	});
});
