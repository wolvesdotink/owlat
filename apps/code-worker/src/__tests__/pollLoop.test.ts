import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPollLoop, type PollLoopSteps } from '../pollLoop.js';

const POLL_INTERVAL_MS = 30_000;

/** A step whose current call stays pending until the test settles it. */
function controlledStep() {
	let finish: (() => void) | undefined;
	const step = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			})
	);
	return {
		step,
		finish: () => {
			if (!finish) throw new Error('the step has not been called');
			finish();
			finish = undefined;
		},
	};
}

describe('createPollLoop', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('drains both queues, idles for the interval, then polls again', async () => {
		const loop = createPollLoop();
		const steps: PollLoopSteps = {
			pollCodeTasks: vi.fn(async () => {}),
			pollPluginTasks: vi.fn(async () => {}),
		};
		const done = loop.run(steps, POLL_INTERVAL_MS);

		await vi.advanceTimersByTimeAsync(0);
		expect(steps.pollCodeTasks).toHaveBeenCalledTimes(1);
		expect(steps.pollPluginTasks).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
		expect(steps.pollCodeTasks).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(steps.pollCodeTasks).toHaveBeenCalledTimes(2);
		expect(steps.pollPluginTasks).toHaveBeenCalledTimes(2);

		loop.requestStop();
		await done;
	});

	it('lets the code-task step finish and then skips the plugin queue', async () => {
		const loop = createPollLoop();
		const code = controlledStep();
		const pollPluginTasks = vi.fn(async () => {});
		let finished = false;
		const done = loop
			.run({ pollCodeTasks: code.step, pollPluginTasks }, POLL_INTERVAL_MS)
			.then(() => {
				finished = true;
			});

		await vi.advanceTimersByTimeAsync(0);
		expect(loop.requestStop()).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		// The running task is not cut short: the loop waits for it.
		expect(finished).toBe(false);

		code.finish();
		await done;
		expect(code.step).toHaveBeenCalledTimes(1);
		expect(pollPluginTasks).not.toHaveBeenCalled();
	});

	it('lets the plugin step finish and then does not poll again', async () => {
		const loop = createPollLoop();
		const plugin = controlledStep();
		const pollCodeTasks = vi.fn(async () => {});
		const done = loop.run({ pollCodeTasks, pollPluginTasks: plugin.step }, POLL_INTERVAL_MS);

		await vi.advanceTimersByTimeAsync(0);
		expect(plugin.step).toHaveBeenCalledTimes(1);
		loop.requestStop();
		plugin.finish();
		await done;

		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
		expect(pollCodeTasks).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cuts the idle sleep short without waiting for the interval', async () => {
		const loop = createPollLoop();
		const steps: PollLoopSteps = {
			pollCodeTasks: vi.fn(async () => {}),
			pollPluginTasks: vi.fn(async () => {}),
		};
		const done = loop.run(steps, POLL_INTERVAL_MS);

		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(1);
		loop.requestStop();
		// No clock advance: the stop alone ends the sleep and clears its timer.
		await done;
		expect(vi.getTimerCount()).toBe(0);
		expect(steps.pollCodeTasks).toHaveBeenCalledTimes(1);
	});

	it('never starts when the stop arrived before the loop', async () => {
		const loop = createPollLoop();
		const steps: PollLoopSteps = {
			pollCodeTasks: vi.fn(async () => {}),
			pollPluginTasks: vi.fn(async () => {}),
		};
		loop.requestStop();
		await loop.run(steps, POLL_INTERVAL_MS);
		expect(steps.pollCodeTasks).not.toHaveBeenCalled();
	});

	it('reports a repeated stop request so the caller logs only the first', () => {
		const loop = createPollLoop();
		expect(loop.requestStop()).toBe(true);
		expect(loop.requestStop()).toBe(false);
	});
});
