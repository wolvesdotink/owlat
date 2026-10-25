/**
 * Report-only timing of the API's regex-bound hostile inputs
 * (helpers/hostileRegexInputs.ts), each at n and 4n: the security scan's style
 * decoding and detection patterns, and the brand kit's colour count. Their
 * tests assert what can be counted or bounded (the scan meter, the input cap,
 * the result); the time spent inside a regular expression is only visible
 * here.
 *
 * The fidelity block always runs. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped,
 * so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { API_REGEX_CASES, SCALING_FACTOR } from './helpers/hostileRegexInputs';
import {
	perfBenchOutput,
	sampleScalingCases,
	writeFamilyResult,
} from '../../../../scripts/perf-bench/sample';

describe('API regex-bound hostile inputs', () => {
	it.each(API_REGEX_CASES)('$name grows by the size factor', (scalingCase) => {
		// The timing ratio means something only if the larger input is about
		// SCALING_FACTOR times the smaller one.
		const small = scalingCase.build(scalingCase.n).length;
		const ratio = scalingCase.build(SCALING_FACTOR * scalingCase.n).length / small;
		expect(ratio).toBeGreaterThan(SCALING_FACTOR - 0.1);
		expect(ratio).toBeLessThanOrEqual(SCALING_FACTOR);
	});
});

const output = perfBenchOutput();

describe.runIf(output)('API regex-bound scaling benchmark (perf:bench only)', () => {
	// No local timeout: the perf:bench driver supplies the shared benchmark budget
	// (PERF_BENCH_TIMEOUT_MS), and a local override would bypass it.
	it('samples each case at n and 4n', () => {
		const { tasks, scaling } = sampleScalingCases(API_REGEX_CASES, SCALING_FACTOR, {
			warmup: 2,
			samples: 10,
			opsPerSample: 1,
		});
		writeFamilyResult(output!, {
			family: 'api-regex-scaling',
			title: 'API regex-bound hostile inputs at n and 4n',
			dataset: {
				'call sites':
					'security_scan patterns (stripHiddenContent, detectSmuggling), workspaces/brandKitWebsite (countCssColors)',
				cases: API_REGEX_CASES.map((c) => `${c.name} (n=${c.n})`).join('; '),
				fixture: 'apps/api/convex/__tests__/helpers/hostileRegexInputs.ts',
			},
			tasks,
			scaling,
		});
		expect(tasks.length).toBe(API_REGEX_CASES.length * 2);
	});
});
