/**
 * Scaling checks for the hostile-input regression tests (issue #1327 and its
 * flake, #1373). Unlike the report-only samplers next to this file, these do
 * gate CI, so they compare two of their own measurements instead of holding a
 * call to a wall-clock budget that a busy runner misses.
 *
 * The check times one call at n and at 4n units of input. Linear code measures
 * about 4; the quadratic regressions these tests guard measured 12x and up.
 * Three things keep machine load out of that number:
 * - the sizes are sampled interleaved (n, 4n, n, 4n, …), so contention that
 *   lasts a while lands on both sizes instead of only the one being timed;
 * - each size keeps its fastest sample, and every sample repeats the call for
 *   at least `minSampleMs` so a cheap input is not timed at the clock's
 *   resolution;
 * - a ratio at or over the bound is measured once more and only the better of
 *   the two counts. A real quadratic regression exceeds the bound every time,
 *   so the retry cannot hide it.
 *
 * Zero dependencies, so a spec in any workspace can import it.
 */

/** Linear stays near 4; every quadratic regression measured so far was 12 or higher. */
export const LINEAR_SCALING_BOUND = 8;

/**
 * Vitest options for a test that measures with `scalingRatio`. The ratio is
 * the guard; a loaded CI runner takes several times longer than a laptop, so
 * the default 5 s test timeout must not become a wall-clock budget.
 */
export const SCALING_TEST = { timeout: 30_000 };

export interface ScalingOptions {
	/** Samples per size and attempt, interleaved. */
	samples?: number;
	/** Each sample repeats the call until this much time has passed. */
	minSampleMs?: number;
	/** Measurements taken while the ratio stays at or over `bound`. */
	attempts?: number;
	/** The ratio that triggers another attempt. */
	bound?: number;
	/** Millisecond clock; tests of this helper pass a virtual one. */
	now?: () => number;
}

/**
 * How much longer `run` takes on `build(4 * n)` than on `build(n)`: the lowest
 * ratio over up to `attempts` measurements, stopping at the first one under
 * `bound`.
 */
export function scalingRatio(
	build: (n: number) => string,
	n: number,
	run: (input: string) => unknown,
	options: ScalingOptions = {}
): number {
	const {
		samples = 5,
		minSampleMs = 10,
		attempts = 2,
		bound = LINEAR_SCALING_BOUND,
		now = () => performance.now(),
	} = options;
	const perCall = (input: string) => {
		const started = now();
		let calls = 0;
		do {
			run(input);
			calls++;
		} while (now() - started < minSampleMs);
		return (now() - started) / calls;
	};
	const small = build(n);
	const large = build(4 * n);
	let best = Number.POSITIVE_INFINITY;
	for (let attempt = 0; attempt < attempts && !(best < bound); attempt++) {
		// Warm-up: JIT and any parser state, for both sizes.
		perCall(small);
		perCall(large);
		let fastestSmall = Number.POSITIVE_INFINITY;
		let fastestLarge = Number.POSITIVE_INFINITY;
		for (let sample = 0; sample < samples; sample++) {
			fastestSmall = Math.min(fastestSmall, perCall(small));
			fastestLarge = Math.min(fastestLarge, perCall(large));
		}
		best = Math.min(best, fastestLarge / fastestSmall);
	}
	return best;
}
