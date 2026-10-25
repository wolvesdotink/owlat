/**
 * Hostile inputs whose cost is spent inside regular expressions, shared by the
 * tests that hold them to their counted or bounded work and the report-only
 * timing in hostileRegexInputs.perf.test.ts, so the benchmark times exactly
 * what the tests run. Each builds its input from a unit count `n`; the tests
 * run the larger size (4n), the benchmark both.
 *
 * Kept free of vitest imports so the benchmark module stays a plain consumer.
 */
import type { ScalingCase } from '../../../../../scripts/perf-bench/sample';
import { countCssColors } from '../../workspaces/brandKitWebsite';
import {
	detectSmuggling,
	MAX_SCAN_INPUT_CHARS,
	stripHiddenContent,
} from '../../agent/steps/security_scan/patterns';

/** The size factor between a case's two benchmark sizes; the tests run the larger. */
export const SCALING_FACTOR = 4;

/**
 * A style attribute holding `n` units, then visible text. At SCALING_FACTOR * n
 * the whole tag still fits under the scan cap, so every size is read in full.
 */
export const styleValueOf = (unit: string) => (n: number) =>
	`<a style="${unit.repeat(n)}">SECRETPAYLOAD</a>`;

/** The unit count at which a style value of `unit` fills the scan cap at the larger size. */
export const styleUnitsFor = (unit: string) =>
	Math.floor((MAX_SCAN_INPUT_CHARS - 32) / unit.length / SCALING_FACTOR);

/** Style values the decoder must read through: references, escapes, comments. */
export const STYLE_VALUE_UNITS: ReadonlyArray<[label: string, unit: string]> = [
	['character references', '&#58;'],
	['long numeric references', '&#x0000000000000000003a;'],
	['CSS escapes and comments', '\\6e /**/'],
	['unclosed CSS comments', '/*'],
];

/** One unterminated style attribute of `n` units, for the detection patterns. */
export const unterminatedStyleOf = (unit: string) => (n: number) => `<p style="${unit.repeat(n)}`;

/** The unit count at which an unterminated style of `unit` fills the scan cap at the larger size. */
export const unterminatedUnitsFor = (unit: string) =>
	Math.floor((MAX_SCAN_INPUT_CHARS - 10) / unit.length / SCALING_FACTOR);

/** Detection-pattern bait: openers with no close, colours with no closing paren. */
export const SMUGGLING_UNITS: ReadonlyArray<[label: string, unit: string]> = [
	['unclosed instruction comments', '<!-- ignore '],
	['colour values in one unterminated style attribute', 'color:rgba(1'],
];

/** A stylesheet of `rgb(` openers that never complete, then one real colour. */
export const unfinishedRgbRun = (n: number) => `${'rgb(   '.repeat(n)}#123456`;

export const API_REGEX_CASES: readonly ScalingCase[] = [
	...STYLE_VALUE_UNITS.map(([label, unit]) => ({
		name: `stripHiddenContent, style value of ${label}`,
		n: styleUnitsFor(unit),
		build: styleValueOf(unit),
		run: (input: string) => stripHiddenContent(input, { html: true }),
	})),
	...SMUGGLING_UNITS.map(([label, unit]) => ({
		name: `detectSmuggling, ${label}`,
		n: unterminatedUnitsFor(unit),
		build: unterminatedStyleOf(unit),
		run: (input: string) => detectSmuggling(input),
	})),
	{
		name: 'countCssColors, unfinished rgb( openers',
		n: 25_000,
		build: unfinishedRgbRun,
		run: (input: string) => countCssColors(input),
	},
];
