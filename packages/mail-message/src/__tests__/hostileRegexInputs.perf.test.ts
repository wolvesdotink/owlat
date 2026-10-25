/**
 * Report-only timing of the parser's text passes on the hostile inputs of
 * helpers/hostileRegexInputs.ts, each at n and 4n: htmlToPlainText in both
 * layouts and the address-list parse. Their tests count the hand-written scans
 * and bound the input; the time spent inside a regular expression is only
 * visible here.
 *
 * The fidelity block always runs. The timing block runs only under
 * `bun run perf:bench`, which sets OWLAT_PERF_BENCH_OUT; in CI it is skipped,
 * so no timing is ever asserted.
 */
import { describe, expect, it } from 'vitest';
import { MAIL_MESSAGE_REGEX_CASES, SCALING_FACTOR } from './helpers/hostileRegexInputs';
import {
	perfBenchOutput,
	sampleScalingCases,
	writeFamilyResult,
} from '../../../../scripts/perf-bench/sample';

describe('mail-message hostile inputs', () => {
	it.each(MAIL_MESSAGE_REGEX_CASES)('$name grows by the size factor', (scalingCase) => {
		// The timing ratio means something only if the larger input is about
		// SCALING_FACTOR times the smaller one.
		const small = scalingCase.build(scalingCase.n).length;
		const ratio = scalingCase.build(SCALING_FACTOR * scalingCase.n).length / small;
		expect(ratio).toBeGreaterThan(SCALING_FACTOR - 0.1);
		expect(ratio).toBeLessThanOrEqual(SCALING_FACTOR);
	});
});

const output = perfBenchOutput();

describe.runIf(output)('mail-message text-pass scaling benchmark (perf:bench only)', () => {
	// No per-test budget here: the driver runs benchmark specs without one.
	it('samples each case at n and 4n', () => {
		const { tasks, scaling } = sampleScalingCases(MAIL_MESSAGE_REGEX_CASES, SCALING_FACTOR, {
			warmup: 3,
			samples: 15,
			opsPerSample: 1,
		});
		writeFamilyResult(output!, {
			family: 'mail-message-regex-scaling',
			title: 'mail-message text passes on hostile input at n and 4n',
			dataset: {
				'call sites':
					'text/htmlToPlainText (snippets, previews, prompts, the outbound text part), parse/address',
				cases: MAIL_MESSAGE_REGEX_CASES.map((c) => `${c.name} (n=${c.n})`).join('; '),
				fixture: 'packages/mail-message/src/__tests__/helpers/hostileRegexInputs.ts',
			},
			tasks,
			scaling,
		});
		expect(tasks.length).toBe(MAIL_MESSAGE_REGEX_CASES.length * 2);
	});
});
