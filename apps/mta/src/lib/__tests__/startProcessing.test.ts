/**
 * Startup must not wait on the GroupMQ loop: `run()` settles only when the
 * worker stops, so the wire reports start while it is still pending.
 */
import { describe, expect, it, vi } from 'vitest';
import { startProcessing } from '../startProcessing.js';

describe('startProcessing', () => {
	it('starts the wire reports while the processing loop is still running', () => {
		const run = vi.fn(() => new Promise<void>(() => {}));
		const handle = { stop: vi.fn() };
		const startReports = vi.fn(() => handle);
		const onLoopFailure = vi.fn();

		const result = startProcessing({ worker: { run }, startReports, onLoopFailure });

		expect(run).toHaveBeenCalledTimes(1);
		expect(startReports).toHaveBeenCalledTimes(1);
		expect(result).toBe(handle);
		expect(onLoopFailure).not.toHaveBeenCalled();
	});

	it('hands a failed loop to onLoopFailure', async () => {
		const err = new Error('loop failed');
		const loop = Promise.reject(err);
		const onLoopFailure = vi.fn();

		startProcessing({ worker: { run: () => loop }, startReports: () => undefined, onLoopFailure });
		// Rejection handlers run in registration order, so this one runs after
		// the handler startProcessing attached.
		await loop.catch(() => {});

		expect(onLoopFailure).toHaveBeenCalledWith(err);
	});

	it('leaves a loop that ends on shutdown alone', async () => {
		const loop = Promise.resolve();
		const onLoopFailure = vi.fn();

		startProcessing({ worker: { run: () => loop }, startReports: () => undefined, onLoopFailure });
		await loop;

		expect(onLoopFailure).not.toHaveBeenCalled();
	});
});
