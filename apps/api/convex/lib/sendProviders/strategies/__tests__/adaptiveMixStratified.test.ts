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
import {
	buildEngagementRanker,
	MIN_STRATIFICATION_COHORT,
} from '../../../../delivery/sendAssignmentRouting';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import {
	assignRanked,
	maxOf,
	mean,
	minOf,
	pointBiserial,
	ranksFromScores,
	shareOfArm,
	syntheticContactIds,
} from './fixtures';

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

	it('a TIED cohort still realises the configured share, not the whole cell', () => {
		// The distribution the synthetic uniform ranks above cannot express, and
		// the common warming case: a cold list where most recipients share one
		// score. `engagementPercentile` hands every member of a tied group the
		// group's UPPER percentile, so an undispersed rank would put the whole
		// tied block above the `1 - s` cut and send it ALL to the own arm — the
		// least engaged recipients promoted, on the flimsiest evidence.
		const sendIds = syntheticContactIds(SIZE, 'tie');
		const contactIds = syntheticContactIds(SIZE, 'tiec');
		const scores = contactIds.map((_, index) => (index < SIZE * 0.6 ? 0 : 10));
		const ranks = ranksFromScores(sendIds, scores);
		for (const ownShare of [0.1, 0.5, 0.9]) {
			const assignments = assignRanked(
				contactIds,
				ranks,
				{ ownShare, mixVersion: 3 },
				{
					campaignId: 'cmp-tie',
				}
			);
			expect(Math.abs(shareOfArm(assignments, 'own') - ownShare)).toBeLessThan(0.03);
		}
	});

	it('an all-zero cohort is dispersed, not ranked at the top', () => {
		const sendIds = syntheticContactIds(SIZE, 'zero');
		const ranks = ranksFromScores(
			sendIds,
			sendIds.map(() => 0)
		);
		const defined = ranks.filter((rank): rank is number => rank !== undefined);
		expect(defined.length).toBe(SIZE);
		expect(maxOf(defined)).toBeLessThan(1);
		expect(Math.abs(mean(defined) - 0.5)).toBeLessThan(0.02);
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

	it('holds on a batch too thin to rank, and engages one recipient later', () => {
		// The branch that decides whether D8's stratified DEFAULT engages at all.
		// Thin data HOLDS (D10): below the minimum cohort nobody gets a rank, so
		// every recipient falls through to the random bucket rather than being
		// ranked against a handful of peers — a 5-person batch would otherwise
		// hand its top recipient a rank of 1.0 on no evidence whatsoever.
		const thinIds = syntheticContactIds(MIN_STRATIFICATION_COHORT - 1, 'thin');
		const thinRanks = ranksFromScores(
			thinIds,
			thinIds.map((_, index) => index)
		);
		expect(thinRanks).toHaveLength(19);
		expect(thinRanks.every((rank) => rank === undefined)).toBe(true);

		// One more recipient and the same cohort ranks.
		const fullIds = syntheticContactIds(MIN_STRATIFICATION_COHORT, 'thin');
		const fullRanks = ranksFromScores(
			fullIds,
			fullIds.map((_, index) => index)
		);
		expect(fullRanks).toHaveLength(20);
		expect(fullRanks.every((rank) => rank !== undefined && rank >= 0 && rank < 1)).toBe(true);

		// And the consequence downstream: a thin batch is assigned by the hash
		// bucket, never by rank.
		const thinAssignments = assignRanked(thinIds, thinRanks, { ownShare: 0.6, mixVersion: 3 });
		expect(thinAssignments.every((assignment) => assignment.basis !== 'stratified')).toBe(true);
	});

	it('ranks each cell against its OWN cohort, and holds the cells too thin to rank', () => {
		// The cohort is PER CELL, because the cut is per cell: `rank >= 1 - s`
		// uses the cell's share, so a rank measured against a different
		// population does not realise that share. This batch mixes a rankable
		// gmail cell with a microsoft cell one recipient short of the minimum,
		// and the two answers must be independent of each other.
		const rankable = MIN_STRATIFICATION_COHORT + 5;
		const thin = MIN_STRATIFICATION_COHORT - 1;
		const recipients = [
			...Array.from({ length: rankable }, (_, index) => ({
				sendId: `snd-g-${index}`,
				email: `g${index}@gmail.com`,
				// The LOW band: batch-wide ranking would push all of these to the
				// bottom of the batch and none of them would ever be selected.
				engagementScore: index,
			})),
			...Array.from({ length: thin }, (_, index) => ({
				sendId: `snd-m-${index}`,
				email: `m${index}@outlook.com`,
				engagementScore: 1_000 + index,
			})),
		];
		const providers = new Map<string, DestinationProviderKey>(
			recipients.map((recipient) => [
				recipient.email,
				recipient.email.endsWith('@gmail.com') ? 'gmail' : 'microsoft',
			])
		);
		const rankFor = buildEngagementRanker(recipients, providers);
		const gmailRanks = recipients.slice(0, rankable).map((recipient) => rankFor(recipient));
		const microsoftRanks = recipients.slice(rankable).map((recipient) => rankFor(recipient));

		// The rankable cell ranks against ITSELF: it spans the full percentile
		// range even though every one of its scores is below every microsoft
		// score.
		expect(gmailRanks.every((rank) => rank !== undefined && rank >= 0 && rank < 1)).toBe(true);
		expect(maxOf(gmailRanks.filter((rank): rank is number => rank !== undefined))).toBeGreaterThan(
			0.9
		);
		expect(minOf(gmailRanks.filter((rank): rank is number => rank !== undefined))).toBeLessThan(
			0.1
		);
		// The thin cell ranks nobody (D10) and falls back to the unbiased bucket,
		// which realises `s` exactly — a strictly harmless degradation.
		expect(microsoftRanks.every((rank) => rank === undefined)).toBe(true);
	});

	it('a rank-correlated slice would be caught by this suite', () => {
		// Guard the guard: the correlation statistic must be able to FAIL. A
		// deliberately rank-derived slice has to trip the same bound the real
		// slice passes.
		const rigged = RANKS.map((rank) => rank > 0.95);
		expect(Math.abs(pointBiserial(rigged, RANKS))).toBeGreaterThan(0.3);
	});
});
