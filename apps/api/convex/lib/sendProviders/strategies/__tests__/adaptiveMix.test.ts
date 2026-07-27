/**
 * `adaptive_mix` — THE SPLIT MATRIX.
 *
 * The controller writes a share and expects the traffic to follow it. If the
 * realised proportion drifts from the configured share, every rate the
 * controller derives is computed over the wrong denominators and the AIMD loop
 * is chasing a number that does not mean what it says.
 */

import { describe, it, expect } from 'vitest';
import { adaptiveMixStrategy, decideMixAssignment, MIX_BUCKET_SPACE } from '../adaptive_mix';
import {
	assignAll,
	assignRanked,
	ranksFromScores,
	shareOfArm,
	syntheticContactIds,
} from './fixtures';

const AUDIENCE = syntheticContactIds(20_000);
const SEND_IDS = syntheticContactIds(20_000, 'snd');
const SHARES = [0, 0.02, 0.5, 0.97, 1];

/** Distinct scores: every recipient has their own percentile. */
const DISTINCT_SCORES = AUDIENCE.map((_, index) => index / AUDIENCE.length);
/**
 * The realistic warming cohort: a long tie at the bottom (never opened, score
 * 0) with a distinct-ish tail. `engagementPercentile` gives every member of the
 * tied block the block's UPPER percentile, so without tie dispersion this
 * cohort sends its entire bottom 70% to the own arm at any s >= 0.3.
 */
const TIED_SCORES = AUDIENCE.map((_, index) => (index < AUDIENCE.length * 0.7 ? 0 : index % 40));
/** The most degenerate real list there is: nobody has engaged with anything. */
const ALL_ZERO_SCORES = AUDIENCE.map(() => 0);

describe('adaptive_mix — split matrix', () => {
	it.each(SHARES)('realises share %s within tolerance over a large audience', (ownShare) => {
		const assignments = assignAll(AUDIENCE, { ownShare, mixVersion: 1 }, { campaignId: 'cmp-1' });
		const realised = shareOfArm(assignments, 'own');
		// 1pp tolerance over 20k draws. The degenerate shares are exact by
		// construction (they short-circuit before the hash), so they are asserted
		// exactly rather than statistically.
		if (ownShare === 0 || ownShare === 1) expect(realised).toBe(ownShare);
		else expect(Math.abs(realised - ownShare)).toBeLessThan(0.01);
	});

	// THE SAME MATRIX ON THE STRATIFIED PATH. Stratification is the D8 default in
	// production, so a matrix that only exercises the random-bucket branch
	// asserts nothing about how the share is realised for real traffic — and the
	// tied cohorts below are the distributions where getting it wrong pushes
	// realised own volume far ABOVE the controller's set point.
	describe.each([
		['distinct scores', DISTINCT_SCORES, 0.02],
		['a mostly-tied cold cohort', TIED_SCORES, 0.03],
		['an all-zero cohort', ALL_ZERO_SCORES, 0.03],
	])('stratified over %s', (_label, scores, tolerance) => {
		const ranks = ranksFromScores(SEND_IDS, scores);

		it.each(SHARES)('realises share %s within tolerance', (ownShare) => {
			const assignments = assignRanked(
				AUDIENCE,
				ranks,
				{ ownShare, mixVersion: 1 },
				{
					campaignId: 'cmp-1',
				}
			);
			const realised = shareOfArm(assignments, 'own');
			if (ownShare === 0 || ownShare === 1) expect(realised).toBe(ownShare);
			else expect(Math.abs(realised - ownShare)).toBeLessThan(tolerance);
		});
	});

	it('actually takes the stratified branch when ranks are present', () => {
		// Guard the guard: if the ranker stopped producing ranks, every assertion
		// above would silently fall back to the random bucket and keep passing.
		const ranks = ranksFromScores(SEND_IDS, DISTINCT_SCORES);
		const assignments = assignRanked(
			AUDIENCE,
			ranks,
			{ ownShare: 0.5, mixVersion: 1 },
			{
				campaignId: 'cmp-1',
			}
		);
		const stratified = assignments.filter((a) => a.basis === 'stratified').length;
		expect(stratified).toBeGreaterThan(AUDIENCE.length * 0.85);
	});

	it('realises the share per campaign, not only in aggregate', () => {
		// A share that is only correct when averaged over campaigns is not a
		// usable control variable: the controller evaluates one window of one
		// cell, which is a handful of campaigns at most.
		for (const campaignId of ['cmp-a', 'cmp-b', 'cmp-c', 'cmp-d']) {
			const assignments = assignAll(AUDIENCE, { ownShare: 0.35, mixVersion: 4 }, { campaignId });
			expect(Math.abs(shareOfArm(assignments, 'own') - 0.35)).toBeLessThan(0.015);
		}
	});

	it('records the clamped share and the normalised version on every decision', () => {
		const decision = decideMixAssignment({
			cell: { ownShare: 1.4, mixVersion: 3.7 },
			recipient: { contactId: 'c1', campaignId: 'cmp' },
		});
		expect(decision.ownShare).toBe(1);
		expect(decision.mixVersion).toBe(3);
		expect(decision.bucket).toBeGreaterThanOrEqual(0);
		expect(decision.bucket).toBeLessThan(MIX_BUCKET_SPACE);
	});

	it('routes the strategy module to the arm the decision names', () => {
		const entries = [
			{ providerType: 'mta' as const, isEnabled: true },
			{ providerType: 'ses' as const, isEnabled: true },
		];
		let own = 0;
		for (const contactId of AUDIENCE.slice(0, 4000)) {
			const route = adaptiveMixStrategy.select(entries, undefined, undefined, {
				kind: 'decide',
				input: {
					cell: { ownShare: 0.25, mixVersion: 2 },
					recipient: { contactId, campaignId: 'cmp-1' },
				},
			});
			expect(route).not.toBeNull();
			if (route?.providerType === 'mta') own += 1;
		}
		expect(Math.abs(own / 4000 - 0.25)).toBeLessThan(0.025);
	});

	it('is registered as a deterministic peer strategy', () => {
		expect(adaptiveMixStrategy.kind).toBe('adaptive_mix');
		expect(adaptiveMixStrategy.isDeterministic).toBe(true);
	});
});
