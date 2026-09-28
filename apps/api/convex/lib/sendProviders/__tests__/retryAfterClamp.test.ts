/**
 * The one `[1 s, 1 h]` clamp every remote retry delay goes through (issue #860,
 * finding 8). It used to be restated at four sites, and the copies disagreed on
 * whether a non-finite value was checked at all.
 */

import { describe, expect, it } from 'vitest';
import {
	clampRetryAfterMs,
	LOCAL_DEFER_MS,
	parseRetryAfterDeltaMs,
	RETRY_AFTER_MAX_MS,
	RETRY_AFTER_MIN_MS,
} from '../errors';

describe('clampRetryAfterMs', () => {
	it.each([
		[5_000, 5_000],
		[10, RETRY_AFTER_MIN_MS],
		[-1, RETRY_AFTER_MIN_MS],
		[RETRY_AFTER_MAX_MS * 2, RETRY_AFTER_MAX_MS],
	])('bounds %d to %d', (input, expected) => {
		expect(clampRetryAfterMs(input, LOCAL_DEFER_MS)).toBe(expected);
	});

	it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		'takes the fallback for %s',
		(input) => {
			expect(clampRetryAfterMs(input, LOCAL_DEFER_MS)).toBe(LOCAL_DEFER_MS);
		}
	);

	it('clamps the fallback too', () => {
		expect(clampRetryAfterMs(undefined, 0)).toBe(RETRY_AFTER_MIN_MS);
		expect(clampRetryAfterMs(undefined, RETRY_AFTER_MAX_MS + 1)).toBe(RETRY_AFTER_MAX_MS);
	});
});

describe('parseRetryAfterDeltaMs', () => {
	it.each([
		[null, undefined],
		['', undefined],
		['0', undefined],
		['-3', undefined],
		['Wed, 21 Oct 2015 07:28:00 GMT', undefined],
		['2', 2_000],
		[' 0.2 ', RETRY_AFTER_MIN_MS],
		['86400', RETRY_AFTER_MAX_MS],
		['1e306', RETRY_AFTER_MAX_MS],
	])('parses %j as %s', (header, expected) => {
		expect(parseRetryAfterDeltaMs(header)).toBe(expected);
	});
});
