/**
 * `adaptive_mix` — degenerate and hostile inputs.
 *
 * DEGENERATE IS NORMAL here, not exceptional: `s = 0` is every cell before the
 * controller ever runs and every cell the relay is carrying, `s = 1` is every
 * standalone deployment (D3), a transactional send has no contact row, and a
 * fresh contact has no engagement score. Each of these is the COMMON case for
 * somebody, so each has to be exactly right rather than merely non-throwing.
 */

import { describe, it, expect } from 'vitest';
import { adaptiveMixStrategy, decideMixAssignment } from '../adaptive_mix';
import type { MixCellState } from '../adaptive_mix';
import type { ProviderEntry } from '../types';
import {
	assignAll,
	assignRanked,
	ranksFromScores,
	shareOfArm,
	syntheticContactIds,
} from './fixtures';

const AUDIENCE = syntheticContactIds(5000, 'deg');
const ENTRIES: ProviderEntry[] = [
	{ providerType: 'mta', isEnabled: true },
	{ providerType: 'ses', isEnabled: true },
];

describe('adaptive_mix — degenerate shares', () => {
	it('s = 0 sends the whole cell to the reference arm (today’s behaviour)', () => {
		const assignments = assignAll(AUDIENCE, { ownShare: 0 }, { campaignId: 'cmp' });
		expect(shareOfArm(assignments, 'reference')).toBe(1);
		expect(assignments.every((a) => a.basis === 'degenerate_reference')).toBe(true);
		expect(assignments.every((a) => a.isCalibration === false)).toBe(true);
	});

	it('s = 0 stays on the reference arm even for the most engaged recipient', () => {
		const decision = decideMixAssignment({
			cell: { ownShare: 0, mixVersion: 9 },
			recipient: { contactId: 'c', campaignId: 'cmp', engagementRank: 1 },
		});
		expect(decision.arm).toBe('reference');
	});

	it('s = 1 sends the whole cell to the own arm', () => {
		const assignments = assignAll(AUDIENCE, { ownShare: 1 }, { campaignId: 'cmp' });
		expect(shareOfArm(assignments, 'own')).toBe(1);
		expect(assignments.every((a) => a.basis === 'degenerate_own')).toBe(true);
		expect(assignments.every((a) => a.isCalibration === false)).toBe(true);
	});

	it('fails CLOSED on a corrupt share — NaN and ±Infinity never raise the own arm', () => {
		// `clampOwnShare` (the shipped write-boundary clamp) sends EVERY
		// non-finite value to the floor: degenerate evidence must never be able
		// to push the own MTA's share up. A negative share clamps there too.
		for (const ownShare of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3]) {
			const decision = decideMixAssignment({
				cell: { ownShare },
				recipient: { contactId: 'c', campaignId: 'cmp' },
			});
			expect(decision.arm).toBe('reference');
			expect(decision.ownShare).toBe(0);
		}
	});
});

describe('adaptive_mix — missing identity and missing rank', () => {
	it('falls back to the sendId key when there is no contactId', () => {
		const first = decideMixAssignment({
			cell: { ownShare: 0.5, mixVersion: 1 },
			recipient: { fallbackKey: 'send-abc' },
		});
		const again = decideMixAssignment({
			cell: { ownShare: 0.5, mixVersion: 1 },
			recipient: { fallbackKey: 'send-abc' },
		});
		expect(again).toEqual(first);
		expect(first.basis).not.toBe('unidentified');
	});

	it('the sendId fallback is still an unbiased split', () => {
		const sendIds = syntheticContactIds(20_000, 'snd');
		const own = sendIds.filter(
			(fallbackKey) =>
				decideMixAssignment({
					cell: { ownShare: 0.3, mixVersion: 2 },
					recipient: { fallbackKey },
				}).arm === 'own'
		).length;
		expect(Math.abs(own / sendIds.length - 0.3)).toBeLessThan(0.015);
	});

	it('with NO identity at all it fails closed to reference, never inventing "own"', () => {
		// There is no draw to reach for: the decision is a total function of its
		// inputs, so an identity-less recipient can only take the arm that costs
		// nothing to get wrong.
		for (const ownShare of [0.02, 0.3, 0.5, 0.97]) {
			const decision = decideMixAssignment({
				cell: { ownShare, mixVersion: 1 },
				recipient: {},
			});
			expect(decision.arm).toBe('reference');
			expect(decision.basis).toBe('unidentified');
			expect(decision.isCalibration).toBe(false);
		}
		// An empty-string key is no key, and must not become one by coercion.
		const emptyKey = decideMixAssignment({
			cell: { ownShare: 0.5, mixVersion: 1 },
			recipient: { contactId: '', fallbackKey: '' },
		});
		expect(emptyKey.basis).toBe('unidentified');
		expect(emptyKey.arm).toBe('reference');
	});

	it('a missing engagement rank falls back to the random bucket, never to "own"', () => {
		const assignments = assignAll(AUDIENCE, { ownShare: 0.2, mixVersion: 1 }, { campaignId: 'c' });
		expect(assignments.some((a) => a.basis === 'stratified')).toBe(false);
		expect(Math.abs(shareOfArm(assignments, 'own') - 0.2)).toBeLessThan(0.02);
	});

	it('a non-finite engagement rank is treated as unknown, not as the top', () => {
		// The dangerous failure would be reading NaN/Infinity as "maximally
		// engaged" and promoting the recipient to the own arm on no evidence.
		for (const engagementRank of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const decision = decideMixAssignment({
				cell: { ownShare: 0.5, mixVersion: 1 },
				recipient: { contactId: 'c', campaignId: 'cmp', engagementRank },
			});
			expect(decision.basis).toBe('random');
		}
	});

	it('an empty-string identity is not an identity', () => {
		const decision = decideMixAssignment({
			cell: { ownShare: 0.5 },
			recipient: { contactId: '', fallbackKey: '' },
		});
		expect(decision.basis).toBe('unidentified');
	});
});

describe('adaptive_mix — strategy-level degeneracy', () => {
	it('returns null with no enabled providers', () => {
		expect(adaptiveMixStrategy.select([], undefined)).toBeNull();
	});

	it('returns null when no mix context is supplied, rather than guessing', () => {
		// A caller with no recipient and no recorded arm (a health probe, a
		// preflight check) gets NO answer, and falls back explicitly. Answering
		// `single`'s answer would put the whole cell on one transport while the
		// assignment rows recorded a split — denominators describing an
		// experiment that never ran.
		expect(adaptiveMixStrategy.select(ENTRIES, 'pool-a', undefined)).toBeNull();
	});

	it('replays a RECORDED arm without re-deciding', () => {
		for (const arm of ['own', 'reference'] as const) {
			const route = adaptiveMixStrategy.select(ENTRIES, undefined, undefined, {
				kind: 'assigned',
				arm,
			});
			expect(route?.providerType).toBe(arm === 'own' ? 'mta' : 'ses');
			// A replayed arm carries no decision: there was nothing to decide.
			expect(route?.mix).toBeUndefined();
		}
	});

	it('carries the decision it took back on the route', () => {
		const route = adaptiveMixStrategy.select(ENTRIES, undefined, undefined, {
			kind: 'decide',
			input: {
				cell: { ownShare: 0.5, mixVersion: 1 },
				recipient: { contactId: 'c', campaignId: 'k' },
			},
		});
		expect(route?.mix?.arm).toBe(route?.providerType === 'mta' ? 'own' : 'reference');
	});

	it('an entirely TIED cohort does not collapse the cell onto the own arm', () => {
		// Everyone shares one engagement score — a freshly-imported list. The
		// percentile helper gives every member the group's UPPER percentile, so
		// an undispersed rank would send 100% of the cell own at any s > 0.
		const sendIds = syntheticContactIds(4000, 'tiedeg');
		const contactIds = syntheticContactIds(4000, 'tiedegc');
		const ranks = ranksFromScores(
			sendIds,
			sendIds.map(() => 0)
		);
		const assignments = assignRanked(
			contactIds,
			ranks,
			{ ownShare: 0.2, mixVersion: 1 },
			{
				campaignId: 'cmp-tied',
			}
		);
		expect(Math.abs(shareOfArm(assignments, 'own') - 0.2)).toBeLessThan(0.04);
	});

	it('still sends when NO reference transport is configured (D2)', () => {
		// The additive-only third-party rule: a standalone deployment with only
		// the own MTA must send every message, whatever the share says. Absence
		// of an external account lowers confidence; it never blocks a send.
		const ownOnly: ProviderEntry[] = [{ providerType: 'mta', isEnabled: true }];
		for (const contactId of AUDIENCE.slice(0, 200)) {
			const route = adaptiveMixStrategy.select(ownOnly, undefined, undefined, {
				kind: 'decide',
				input: {
					cell: { ownShare: 0.01, mixVersion: 1 },
					recipient: { contactId, campaignId: 'cmp' },
				},
			});
			expect(route?.providerType).toBe('mta');
		}
	});

	it('still sends when the own MTA is not in the route', () => {
		const referenceOnly: ProviderEntry[] = [{ providerType: 'ses', isEnabled: true }];
		const route = adaptiveMixStrategy.select(referenceOnly, undefined, undefined, {
			kind: 'decide',
			input: {
				cell: { ownShare: 1, mixVersion: 1 },
				recipient: { contactId: 'c', campaignId: 'cmp' },
			},
		});
		expect(route?.providerType).toBe('ses');
	});

	it.each([
		['no reference transport', [{ providerType: 'mta', isEnabled: true }] as ProviderEntry[]],
		['no own MTA', [{ providerType: 'ses', isEnabled: true }] as ProviderEntry[]],
	])('clears the calibration flag on a ONE-ARMED route (%s)', (_label, entries) => {
		// A calibration row is a member of a randomized COMPARISON. With one arm
		// configured every slice member dispatches on the same transport, so the
		// cohort would be one-armed — the bias D8 carves the slice out to avoid.
		// The strategy is the only module that can see both arms, so it is the
		// one that clears the flag; the recorder copies it through.
		let sawSliceMember = false;
		for (const contactId of AUDIENCE.slice(0, 400)) {
			const input = {
				cell: { ownShare: 0.4, mixVersion: 5 },
				recipient: { contactId, campaignId: 'cmp-one-armed' },
			};
			if (decideMixAssignment(input).isCalibration) sawSliceMember = true;
			const route = adaptiveMixStrategy.select(entries, undefined, undefined, {
				kind: 'decide',
				input,
			});
			expect(route?.mix?.isCalibration).toBe(false);
		}
		// The guard is only meaningful if the slice was non-empty to begin with.
		expect(sawSliceMember).toBe(true);
	});

	it('ignores an unknown destination provider by construction', () => {
		// The cell axis never reaches the decision function: the classifier's
		// answer selects WHICH cell's share is read, and an unclassifiable
		// domain is dropped upstream. So an "unknown provider" is simply a cell
		// with no state, which resolves to the D1 default of s = 1.
		const noState: MixCellState = { ownShare: 1 };
		expect(decideMixAssignment({ cell: noState, recipient: { contactId: 'c' } }).arm).toBe('own');
	});

	it('never throws on a hostile combination of inputs', () => {
		const shares = [Number.NaN, -1, 0, 0.5, 1, 2, Number.POSITIVE_INFINITY];
		const versions = [undefined, Number.NaN, -5, 0, 1e9];
		const ranks = [undefined, Number.NaN, -1, 0, 0.5, 1, 2];
		for (const ownShare of shares) {
			for (const mixVersion of versions) {
				for (const engagementRank of ranks) {
					const decision = decideMixAssignment({
						cell: { ownShare, mixVersion },
						recipient: { contactId: 'c', campaignId: 'cmp', engagementRank },
					});
					expect(['own', 'reference']).toContain(decision.arm);
					expect(Number.isFinite(decision.ownShare)).toBe(true);
					expect(Number.isInteger(decision.mixVersion)).toBe(true);
				}
			}
		}
	});
});
