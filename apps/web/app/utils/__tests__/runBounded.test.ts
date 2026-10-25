/**
 * runBounded: a bulk verb's writes, a few at a time. Counted, never timed: the
 * tasks resolve when the test lets them, so "at most N in flight" is an exact
 * assertion rather than a race.
 */
import { describe, expect, it } from 'vitest';
import { runBounded } from '../runBounded';

function deferred() {
	let resolve!: () => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('runBounded', () => {
	it('keeps at most `limit` tasks in flight and starts them in order', async () => {
		const gates = Array.from({ length: 6 }, deferred);
		// Each task signals its own start, so the test waits on the milestone it
		// asserts about rather than on the clock.
		const starts = Array.from({ length: 6 }, deferred);
		const started: number[] = [];
		let inFlight = 0;
		let peak = 0;
		const done = runBounded([0, 1, 2, 3, 4, 5], 2, async (i) => {
			started.push(i);
			starts[i]!.resolve();
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await gates[i]!.promise;
			inFlight -= 1;
		});
		await starts[1]!.promise;
		expect(started).toEqual([0, 1]);
		// Only task 1 has finished, so exactly one more may start: task 2.
		gates[1]!.resolve();
		await starts[2]!.promise;
		expect(started).toEqual([0, 1, 2]);
		for (const gate of gates) gate.resolve();
		await done;
		expect(started).toEqual([0, 1, 2, 3, 4, 5]);
		expect(peak).toBe(2);
	});

	it('runs the rest when one task throws', async () => {
		const ran: number[] = [];
		await runBounded([1, 2, 3], 1, async (i) => {
			ran.push(i);
			if (i === 1) throw new Error('boom');
		});
		expect(ran).toEqual([1, 2, 3]);
	});

	it('settles at once for no items', async () => {
		let called = false;
		await runBounded([], 4, async () => {
			called = true;
		});
		expect(called).toBe(false);
	});
});
