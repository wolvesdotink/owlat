/**
 * Report-only timing of the web app's regex-bound hostile inputs
 * (hostileRegexInputs.ts), each at n and 4n: the analytics sanitizer's URL
 * patterns and the reader's trailing-blank trim. Their tests run the same
 * inputs for the result; the time spent inside a regular expression is only
 * visible here.
 *
 * The fidelity block always runs. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped,
 * so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { SCALING_FACTOR, WEB_REGEX_CASES } from './hostileRegexInputs';
import {
	perfBenchOutput,
	sampleScalingCases,
	writeFamilyResult,
} from '../../../../../scripts/perf-bench/sample';

describe('web regex-bound hostile inputs', () => {
	it.each(WEB_REGEX_CASES)('$name grows by the size factor', (scalingCase) => {
		// The timing ratio means something only if the larger input is about
		// SCALING_FACTOR times the smaller one.
		const small = scalingCase.build(scalingCase.n).length;
		const ratio = scalingCase.build(SCALING_FACTOR * scalingCase.n).length / small;
		expect(ratio).toBeGreaterThan(SCALING_FACTOR - 0.1);
		expect(ratio).toBeLessThanOrEqual(SCALING_FACTOR);
	});
});

const output = perfBenchOutput();

describe.runIf(output)('web regex-bound scaling benchmark (perf:bench only)', () => {
	// No local timeout: the perf:bench driver supplies the shared benchmark budget
	// (PERF_BENCH_TIMEOUT_MS), and a local override would bypass it.
	it('samples each case at n and 4n', () => {
		const { tasks, scaling } = sampleScalingCases(WEB_REGEX_CASES, SCALING_FACTOR, {
			warmup: 3,
			samples: 15,
			opsPerSample: 1,
		});
		writeFamilyResult(output!, {
			family: 'web-regex-scaling',
			title: 'Web regex-bound hostile inputs at n and 4n',
			dataset: {
				'call sites':
					'lib/analyticsPrivacy (sanitizeAnalyticsEvent), utils/postboxBodyTidy (trimTrailingBlankBlocks)',
				cases: WEB_REGEX_CASES.map((c) => `${c.name} (n=${c.n})`).join('; '),
				fixture: 'apps/web/app/lib/__tests__/hostileRegexInputs.ts',
			},
			tasks,
			scaling,
		});
		expect(tasks.length).toBe(WEB_REGEX_CASES.length * 2);
	});
});
