/**
 * Hostile inputs whose cost is spent inside regular expressions, shared by the
 * tests that run them for their result and the report-only timing in
 * hostileRegexInputs.perf.test.ts, so the benchmark times exactly what the
 * tests run. Each builds its input from a unit count `n`; the tests run the
 * larger size (SCALING_FACTOR * n), the benchmark both.
 */
import type { CaptureResult } from 'posthog-js';
import type { ScalingCase } from '../../../../../scripts/perf-bench/sample';
import { sanitizeAnalyticsEvent, type AnalyticsUrlContext } from '../analyticsPrivacy';
import { trimTrailingBlankBlocks } from '../../utils/postboxBodyTidy';

/** The size factor between a case's two benchmark sizes; the tests run the larger. */
export const SCALING_FACTOR = 4;

/** Runs of URL-like characters a URL pattern could retry from every offset. */
export const URL_LIKE_UNITS = [
	'a.',
	'a-',
	'a+',
	'a%',
	'%2F',
	'www.',
	'?a',
	'a/',
	'/',
	'href="',
	'\\',
	'.',
	'./',
	'a%3A',
	'https:',
	'token=',
] as const;

/** The unit count at which a run of `unit` is about 25,000 characters. */
export const urlLikeUnitsFor = (unit: string) => Math.ceil(25_000 / unit.length);

/** An exception message of `n` units. */
export const urlLikeRunOf = (unit: string) => (n: number) => unit.repeat(n);

/** An analytics `$exception` event carrying `message`, as the SDK hands it over. */
export const exceptionEvent = (message: string): CaptureResult => ({
	uuid: 'u1',
	event: '$exception',
	properties: { $exception_message: message },
});

/** A dashboard page with no route of interest: the text sanitizer still runs in full. */
export const ANALYTICS_CONTEXT: AnalyticsUrlContext = {
	base: 'https://app.example.com/dashboard',
	routeOf: () => null,
};

/** A trailing block of `n` raw nbsp that ends in text, so the blank pattern must fail. */
export const nbspBlockEndingInText = (n: number) => `<p>Hi</p><p>${' '.repeat(n)}x</p>`;

export const WEB_REGEX_CASES: readonly ScalingCase[] = [
	...URL_LIKE_UNITS.map((unit) => ({
		name: `sanitizeAnalyticsEvent, run of ${JSON.stringify(unit)}`,
		n: urlLikeUnitsFor(unit),
		build: urlLikeRunOf(unit),
		run: (input: string) => sanitizeAnalyticsEvent(exceptionEvent(input), ANALYTICS_CONTEXT),
	})),
	{
		name: 'trimTrailingBlankBlocks, nbsp block ending in text',
		n: 1_000,
		build: nbspBlockEndingInText,
		run: (input: string) => trimTrailingBlankBlocks(input),
	},
];
