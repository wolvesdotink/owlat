/**
 * Hostile bodies for `scanContent`, whose content rules spend their time inside
 * regular expressions. Shared by the tests that hold the scan to its input cap
 * and the report-only timing in hostileRegexInputs.perf.test.ts, so the
 * benchmark times exactly what the tests run. Each builds a body from a unit
 * count `n`; the tests run the larger size (SCALING_FACTOR * n), which fills
 * the scan cap, the benchmark both.
 */
import type { ScalingCase } from '../../../../scripts/perf-bench/sample';
import { scanContent } from '../content/index.js';
import { MAX_CONTENT_SCAN_CHARS } from '../content/htmlScan.js';

/** The size factor between a case's two benchmark sizes; the tests run the larger. */
export const SCALING_FACTOR = 4;

/** Markup a tag, link or comment pattern could retry from every offset. */
export const HOSTILE_UNITS: ReadonlyArray<[label: string, unit: string]> = [
	['unclosed anchors with href', '<a href="x" '],
	['closed anchor tags without </a>', '<a href="x">'],
	['anchors with unterminated quoted values', '<a x="'],
	['anchors with unterminated single-quoted values', "<a x='"],
	['tag openers', '<'],
	['unclosed style openers', '<style'],
	['unclosed script openers', '<script>'],
	['unclosed comments', '<!--'],
];

/** The unit count at which a body of `unit` fills the scan cap at the larger size. */
export const hostileUnitsFor = (unit: string) =>
	Math.ceil(MAX_CONTENT_SCAN_CHARS / unit.length / SCALING_FACTOR);

export const bodyOf = (unit: string) => (n: number) => unit.repeat(n);

export const SCAN_CONTENT_CASES: readonly ScalingCase[] = HOSTILE_UNITS.map(([label, unit]) => ({
	name: `scanContent, ${label}`,
	n: hostileUnitsFor(unit),
	build: bodyOf(unit),
	run: (input: string) => scanContent('subject', input, { from: 'a@example.com' }),
}));
