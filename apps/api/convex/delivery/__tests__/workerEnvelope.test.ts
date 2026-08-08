/**
 * Pure unit coverage for the send envelope's engagement-score normalisation.
 *
 * The rule is deliberately NOT "clamp into range": an out-of-band or non-finite
 * score is an upstream defect, and inventing a priority band for it would
 * silently mis-order real mail. Unknown is the safe answer — the MTA applies
 * `PRIORITY_BANDS.DEFAULT` when the field is absent.
 */

import { describe, expect, it } from 'vitest';
import { normalizeEngagementScore } from '../workerEnvelope';

describe('normalizeEngagementScore', () => {
	it.each([0, 1, 19, 50, 79, 80, 100])('passes the in-band score %p through', (score) => {
		expect(normalizeEngagementScore(score)).toBe(score);
	});

	it('keeps 0 distinct from absent — 0 is the cold band, undefined is unknown', () => {
		expect(normalizeEngagementScore(0)).toBe(0);
		expect(normalizeEngagementScore(undefined)).toBeUndefined();
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5, 100.5, 1e9])(
		'treats the degenerate score %p as unknown',
		(score) => {
			expect(normalizeEngagementScore(score)).toBeUndefined();
		}
	);

	it('preserves fractional in-band scores rather than rounding them', () => {
		expect(normalizeEngagementScore(79.5)).toBe(79.5);
	});
});
