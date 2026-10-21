/**
 * The scaling check behind the hostile-input tests (#1373), driven by a virtual
 * clock: `run` advances the clock by what one call costs, so every ratio here
 * is exact and the contention scenarios are reproducible.
 */

import { describe, expect, it } from 'vitest';
import { LINEAR_SCALING_BOUND, scalingRatio } from '../perf-bench/scalingRatio';

/** One unit of input per character, so `n = 1` compares 1 against 4 units. */
const build = (n: number) => 'x'.repeat(n);

/**
 * A runner whose call cost depends on input length and on when the call
 * starts. `slowdown` returns the contention factor for a call of `units`
 * starting at virtual time `startedAt`.
 */
function virtualRunner(
	cost: (units: number) => number,
	slowdown: (units: number, startedAt: number) => number = () => 1
) {
	let clock = 0;
	const calls = { small: 0, large: 0 };
	return {
		calls,
		now: () => clock,
		run: (input: string) => {
			calls[input.length === 1 ? 'small' : 'large']++;
			clock += cost(input.length) * slowdown(input.length, clock);
		},
	};
}

const linear = (units: number) => units;
const quadratic = (units: number) => units * units;

describe('scalingRatio', () => {
	it('measures linear work at 4', () => {
		const runner = virtualRunner(linear);
		expect(scalingRatio(build, 1, runner.run, { now: runner.now })).toBe(4);
	});

	it('measures quadratic work at 16 on every attempt', () => {
		const runner = virtualRunner(quadratic);
		const ratio = scalingRatio(build, 1, runner.run, { now: runner.now });
		expect(ratio).toBe(16);
		expect(ratio).toBeGreaterThanOrEqual(LINEAR_SCALING_BOUND);
		// One call per large sample: a warm-up and five samples per attempt, two attempts.
		expect(runner.calls.large).toBe(12);
	});

	it('stops after the first attempt under the bound', () => {
		const runner = virtualRunner(linear);
		scalingRatio(build, 1, runner.run, { now: runner.now });
		// A large sample is three 4 ms calls: a warm-up and five samples, one attempt.
		expect(runner.calls.large).toBe(18);
	});

	it('is not skewed by contention over the first half of an attempt', () => {
		// The runner is three times slower for both sizes during the first 60 ms.
		const busyFirstHalf = (_units: number, startedAt: number) => (startedAt < 60 ? 3 : 1);
		const runner = virtualRunner(linear, busyFirstHalf);
		expect(scalingRatio(build, 1, runner.run, { now: runner.now, attempts: 1 })).toBe(4);
	});

	it('recovers when one whole attempt timed the large input on a contended runner', () => {
		// Large calls are three times slower for the whole first attempt (130 ms).
		const busyLargeAtFirst = (units: number, startedAt: number) =>
			units > 1 && startedAt < 130 ? 3 : 1;

		const once = virtualRunner(linear, busyLargeAtFirst);
		expect(scalingRatio(build, 1, once.run, { now: once.now, attempts: 1 })).toBe(12);

		const retried = virtualRunner(linear, busyLargeAtFirst);
		expect(scalingRatio(build, 1, retried.run, { now: retried.now })).toBe(4);
	});
});
