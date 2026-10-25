/**
 * Hostile inputs for the parser's text passes, shared by the tests that count
 * their scans or bound their input and the report-only timing in
 * hostileRegexInputs.perf.test.ts, so the benchmark times exactly what the
 * tests run. Each builds its input from a unit count `n`; the tests run the
 * larger size (SCALING_FACTOR * n), the benchmark both.
 */
import type { ScalingCase } from '../../../../../scripts/perf-bench/sample';
import { htmlToPlainText } from '../../text/htmlToPlainText';
import { parseAddressList } from '../../parse/address';

/** The size factor between a case's two benchmark sizes; the tests run the larger. */
export const SCALING_FACTOR = 4;

export interface HostileShape {
	name: string;
	n: number;
	build: (n: number) => string;
}

const repeated = (name: string, unit: string, n: number): HostileShape => ({
	name,
	n,
	build: (count) => unit.repeat(count),
});

/**
 * Bodies that defeat a naive pattern: `<[^>]+>` retried from every `<`, a lazy
 * `[\s\S]*?</script>` per unterminated opening tag, `<head>` with no close, and
 * entity look-alikes. At the larger size each is the 200,000-unit body the
 * tests have always run.
 */
export const HTML_TO_TEXT_SHAPES: readonly HostileShape[] = [
	repeated('bare <', '<', 50_000),
	repeated('open tag start', '<a', 50_000),
	repeated('unterminated scripts', '<script>', 12_500),
	repeated('unterminated heads', '<head>', 12_500),
	repeated('comment openers', '<!-', 50_000),
	repeated('br look-alikes', '<br ', 50_000),
	repeated('closing look-alikes', '</p ', 50_000),
	repeated('entity look-alikes', '&#1', 50_000),
	{ name: 'whitespace runs', n: 50_000, build: (count) => `${' \n'.repeat(count)}x` },
	repeated('nbsp runs', '&nbsp;  ', 12_500),
];

/**
 * An address header of `A<` pairs with no closing `>`: clean O(n^2) for the
 * retired anchored regex. Past the 16 KiB cap only the cap is read, so the
 * benchmark sizes stay under it.
 */
export const unclosedAngleRun: HostileShape = {
	name: 'parseAddressList, A< run with no closing >',
	n: 2_000,
	build: (count) => 'A<'.repeat(count),
};

export const MAIL_MESSAGE_REGEX_CASES: readonly ScalingCase[] = [
	...HTML_TO_TEXT_SHAPES.flatMap((shape) => [
		{
			...shape,
			name: `htmlToPlainText, ${shape.name}`,
			run: (input: string) => htmlToPlainText(input),
		},
		{
			...shape,
			name: `htmlToPlainText (preserveBreaks), ${shape.name}`,
			run: (input: string) => htmlToPlainText(input, { preserveBreaks: true }),
		},
	]),
	{ ...unclosedAngleRun, run: (input: string) => parseAddressList(input) },
];
