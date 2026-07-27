/**
 * `adaptive_mix` — stratification, and the independence of the calibration
 * slice from engagement rank (plan D8).
 *
 * THIS IS THE FILE THE WHOLE MEASUREMENT PLANE RESTS ON. Stratified assignment
 * deliberately biases the own arm towards engaged recipients — that is the
 * right WARMING policy. It also makes any engagement comparison between the two
 * arms meaningless. The randomized calibration slice is the answer, and it only
 * works if slice membership is INDEPENDENT of engagement rank. If it correlates
 * even slightly, every ratio the controller ever reads is biased and no later
 * test would catch it, because a biased ratio looks exactly like a real one.
 */

import { describe, it, expect } from 'vitest';
import { decideMixAssignment, type MixAssignment } from '../adaptive_mix';
import { syntheticContactIds } from './fixtures';

const SIZE = 20_000;
const IDS = syntheticContactIds(SIZE);
/** Uniform ranks in (0,1] — 1 = most engaged, as `engagementPercentile` emits. */
const RANKS = IDS.map((_, index) => (index + 1) / SIZE);

function assignStratified(ownShare: number, mixVersion = 3): MixAssignment[] {
	return IDS.map((contactId, index) =>
		decideMixAssignment({
			cell: { ownShare, mixVersion },
			recipient: { contactId, campaignId: 'cmp-strat', engagementRank: RANKS[index] },
		})
	);
}

/** Fold rather than `Math.min(...array)`: the audience overflows the arg limit. */
function minOf(values: readonly number[]): number {
	return values.reduce((low, value) => (value < low ? value : low), Number.POSITIVE_INFINITY);
}

function maxOf(values: readonly number[]): number {
	return values.reduce((high, value) => (value > high ? value : high), Number.NEGATIVE_INFINITY);
}

function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Pearson correlation between slice membership (0/1) and engagement rank. */
function pointBiserial(flags: readonly boolean[], values: readonly number[]): number {
	const n = flags.length;
	const flagValues = flags.map((flag) => (flag ? 1 : 0));
	const meanFlag = mean(flagValues);
	const meanValue = mean(values);
	let cov = 0;
	let varFlag = 0;
	let varValue = 0;
	for (let index = 0; index < n; index += 1) {
		const dFlag = (flagValues[index] ?? 0) - meanFlag;
		const dValue = (values[index] ?? 0) - meanValue;
		cov += dFlag * dValue;
		varFlag += dFlag * dFlag;
		varValue += dValue * dValue;
	}
	if (varFlag === 0 || varValue === 0) return 0;
	return cov / Math.sqrt(varFlag * varValue);
}

describe('adaptive_mix — stratified assignment', () => {
	it('sends the TOP engagement fraction to the own arm outside the slice', () => {
		const assignments = assignStratified(0.6);
		const stratified = assignments
			.map((assignment, index) => ({ assignment, rank: RANKS[index] ?? 0 }))
			.filter((row) => row.assignment.basis === 'stratified');
		expect(stratified.length).toBeGreaterThan(SIZE * 0.9);

		// Every own row outranks every reference row: the cut is a threshold on
		// the rank, not a coin flip weighted by it.
		const ownRanks = stratified.filter((row) => row.assignment.arm === 'own').map((r) => r.rank);
		const referenceRanks = stratified
			.filter((row) => row.assignment.arm === 'reference')
			.map((r) => r.rank);
		expect(minOf(ownRanks)).toBeGreaterThan(maxOf(referenceRanks));
		// And the cut lands at 1 - s.
		expect(Math.abs(minOf(ownRanks) - 0.4)).toBeLessThan(0.01);
	});

	it('an explicit isStratified:false falls back to the unbiased hash bucket', () => {
		const assignments = IDS.map((contactId, index) =>
			decideMixAssignment({
				cell: { ownShare: 0.6, mixVersion: 3, isStratified: false },
				recipient: { contactId, campaignId: 'cmp-strat', engagementRank: RANKS[index] },
			})
		);
		expect(assignments.some((assignment) => assignment.basis === 'stratified')).toBe(false);
		const ownRanks = assignments
			.map((assignment, index) => ({ assignment, rank: RANKS[index] ?? 0 }))
			.filter((row) => row.assignment.arm === 'own')
			.map((row) => row.rank);
		// Unstratified: the own arm's mean rank is the population's.
		expect(Math.abs(mean(ownRanks) - 0.5)).toBeLessThan(0.02);
	});
});

describe('adaptive_mix — the calibration slice is independent of engagement', () => {
	it.each([0.2, 0.6, 0.9])(
		'slice membership does not correlate with engagement rank at s=%s',
		(ownShare) => {
			const assignments = assignStratified(ownShare);
			const flags = assignments.map((assignment) => assignment.isCalibration);
			expect(Math.abs(pointBiserial(flags, RANKS))).toBeLessThan(0.03);
		}
	);

	it('the slice has the population mean engagement rank', () => {
		const assignments = assignStratified(0.6);
		const sliceRanks = assignments
			.map((assignment, index) => ({ assignment, rank: RANKS[index] ?? 0 }))
			.filter((row) => row.assignment.isCalibration)
			.map((row) => row.rank);
		expect(sliceRanks.length).toBeGreaterThan(500);
		expect(Math.abs(mean(sliceRanks) - 0.5)).toBeLessThan(0.05);
	});

	it('assigns arms WITHIN the slice at random, not by rank', () => {
		const assignments = assignStratified(0.6);
		const slice = assignments
			.map((assignment, index) => ({ assignment, rank: RANKS[index] ?? 0 }))
			.filter((row) => row.assignment.isCalibration);
		const ownRanks = slice.filter((row) => row.assignment.arm === 'own').map((row) => row.rank);
		const referenceRanks = slice
			.filter((row) => row.assignment.arm === 'reference')
			.map((row) => row.rank);
		// Both arms of the slice look like the whole population. Under
		// stratification the reference arm's mean rank would be ~0.2 and the own
		// arm's ~0.7 — this is precisely the bias the slice must not have.
		expect(Math.abs(mean(ownRanks) - 0.5)).toBeLessThan(0.06);
		expect(Math.abs(mean(referenceRanks) - 0.5)).toBeLessThan(0.06);
		// The slice's own-share still tracks the configured share.
		expect(Math.abs(ownRanks.length / slice.length - 0.6)).toBeLessThan(0.06);
	});

	it('a rank-correlated slice would be caught by this suite', () => {
		// Guard the guard: the correlation statistic must be able to FAIL. A
		// deliberately rank-derived slice has to trip the same bound the real
		// slice passes.
		const rigged = RANKS.map((rank) => rank > 0.95);
		expect(Math.abs(pointBiserial(rigged, RANKS))).toBeGreaterThan(0.3);
	});
});
