/**
 * Report-only timing of shared's regex-bound hostile inputs
 * (hostileRegexInputs.ts), each at n and 4n: the exact-wording detector's
 * patterns on its capped body and uncapped subject, and the clearsigned-text
 * extraction on a long blank run. Their tests run the same inputs for the
 * result and pin the body cap; the time spent inside a regular expression is
 * only visible here.
 *
 * The fidelity block always runs. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped,
 * so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { SCALING_FACTOR, SHARED_REGEX_CASES } from './hostileRegexInputs';
import {
	perfBenchOutput,
	sampleScalingCases,
	writeFamilyResult,
} from '../../../../scripts/perf-bench/sample';

describe('shared regex-bound hostile inputs', () => {
	it.each(SHARED_REGEX_CASES)('$name grows by the size factor', (scalingCase) => {
		// The timing ratio means something only if the larger input is about
		// SCALING_FACTOR times the smaller one.
		const small = scalingCase.build(scalingCase.n).length;
		const ratio = scalingCase.build(SCALING_FACTOR * scalingCase.n).length / small;
		expect(ratio).toBeGreaterThan(SCALING_FACTOR - 0.1);
		expect(ratio).toBeLessThanOrEqual(SCALING_FACTOR);
	});
});

const output = perfBenchOutput();

describe.runIf(output)('shared regex-bound scaling benchmark (perf:bench only)', () => {
	// No per-test budget here: the driver runs benchmark specs without one.
	it('samples each case at n and 4n', () => {
		const { tasks, scaling } = sampleScalingCases(SHARED_REGEX_CASES, SCALING_FACTOR, {
			warmup: 3,
			samples: 15,
			opsPerSample: 1,
		});
		writeFamilyResult(output!, {
			family: 'shared-regex-scaling',
			title: 'shared regex-bound hostile inputs at n and 4n',
			dataset: {
				'call sites':
					'exactWordingDetector (the agent pipeline), secureMessage (the reader and inbound sealing)',
				cases: SHARED_REGEX_CASES.map((c) => `${c.name} (n=${c.n})`).join('; '),
				fixture: 'packages/shared/src/__tests__/hostileRegexInputs.ts',
			},
			tasks,
			scaling,
		});
		expect(tasks.length).toBe(SHARED_REGEX_CASES.length * 2);
	});
});
