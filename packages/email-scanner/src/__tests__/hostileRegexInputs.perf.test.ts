/**
 * Report-only timing of `scanContent` on the hostile bodies of
 * hostileRegexInputs.ts, each at n and 4n. The tests count the link scan's
 * reads and hold every content rule to the scan cap; the time the rules spend
 * inside their regular expressions is only visible here.
 *
 * The fidelity block always runs. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped,
 * so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { SCALING_FACTOR, SCAN_CONTENT_CASES } from './hostileRegexInputs.js';
import {
	perfBenchOutput,
	sampleScalingCases,
	writeFamilyResult,
} from '../../../../scripts/perf-bench/sample';

describe('scanContent hostile bodies', () => {
	it.each(SCAN_CONTENT_CASES)('$name grows by the size factor', (scalingCase) => {
		// The timing ratio means something only if the larger body is about
		// SCALING_FACTOR times the smaller one.
		const small = scalingCase.build(scalingCase.n).length;
		const ratio = scalingCase.build(SCALING_FACTOR * scalingCase.n).length / small;
		expect(ratio).toBeGreaterThan(SCALING_FACTOR - 0.1);
		expect(ratio).toBeLessThanOrEqual(SCALING_FACTOR);
	});
});

const output = perfBenchOutput();

describe.runIf(output)('scanContent scaling benchmark (perf:bench only)', () => {
	// No local timeout: the perf:bench driver supplies the shared benchmark budget
	// (PERF_BENCH_TIMEOUT_MS), and a local override would bypass it.
	it('samples each body at n and 4n', () => {
		const { tasks, scaling } = sampleScalingCases(SCAN_CONTENT_CASES, SCALING_FACTOR, {
			warmup: 2,
			samples: 10,
			opsPerSample: 1,
		});
		writeFamilyResult(output!, {
			family: 'scan-content-scaling',
			title: 'scanContent on hostile bodies at n and 4n',
			dataset: {
				'call sites': 'the MTA content scan (packages/email-scanner, content/index.ts)',
				cases: SCAN_CONTENT_CASES.map((c) => `${c.name} (n=${c.n})`).join('; '),
				fixture: 'packages/email-scanner/src/__tests__/hostileRegexInputs.ts',
			},
			tasks,
			scaling,
		});
		expect(tasks.length).toBe(SCAN_CONTENT_CASES.length * 2);
	});
});
