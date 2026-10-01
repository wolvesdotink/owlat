import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../mapWithConcurrency';

/** A promise the test resolves by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Let every queued microtask (and the continuations they queue) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('mapWithConcurrency', () => {
	it('keeps at most `limit` calls in flight and returns results in input order', async () => {
		const gates = Array.from({ length: 6 }, () => deferred<void>());
		let inFlight = 0;
		let peak = 0;
		const started: number[] = [];

		const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 3, async (item) => {
			started.push(item);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await gates[item]!.promise;
			inFlight -= 1;
			return item * 10;
		});

		await flush();
		expect(started).toEqual([0, 1, 2]);
		// Finish out of order: the result array still follows the input.
		gates[2]!.resolve();
		await flush();
		expect(started).toEqual([0, 1, 2, 3]);
		for (const gate of gates) gate.resolve();

		expect(await run).toEqual([0, 10, 20, 30, 40, 50]);
		expect(peak).toBe(3);
	});

	it('starts nothing new once a result satisfies stopWhen, and keeps what finished', async () => {
		const started: number[] = [];
		const results = await mapWithConcurrency(
			[0, 1, 2, 3, 4, 5],
			2,
			async (item) => {
				started.push(item);
				return item === 1 ? 'stop' : 'ok';
			},
			{ stopWhen: (result) => result === 'stop' }
		);

		expect(results.slice(0, 2)).toEqual(['ok', 'stop']);
		expect(started.length).toBeLessThan(6);
		expect(results.filter((r) => r === undefined)).toHaveLength(6 - started.length);
	});

	it('rejects with the failure once the calls in flight have settled', async () => {
		const boom = new Error('boom');
		let settledAfterFailure = false;
		const run = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
			if (item === 0) throw boom;
			await flush();
			settledAfterFailure = true;
			return item;
		});

		await expect(run).rejects.toBe(boom);
		expect(settledAfterFailure).toBe(true);
	});

	it('handles an empty list', async () => {
		expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
	});
});
