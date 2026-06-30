/**
 * Unit tests for the pure A/B variant split helpers consumed by the
 * Campaign send orchestrator (module). The helpers live in a non-node
 * file so they can be tested without the workpool / provider stack.
 *
 * The split is computed by a DETERMINISTIC per-contact hash
 * (`hashFraction`) rather than a global shuffle, so the A/B send streams
 * through the same checkpointed walker as a plain send. These tests pin the
 * hash's determinism + uniform distribution and the cohort/variant
 * partitioning that the walker relies on.
 */

import { describe, it, expect } from 'vitest';
import {
	resolveAbFanout,
	hashFraction,
	testFractionForSplit,
	variantForHash,
} from '../campaigns/sendVariantSplit';
import type { Doc, Id } from '../_generated/dataModel';

// ─── resolveAbFanout ────────────────────────────────────────────────────

function makeCampaign(overrides: Partial<Doc<'campaigns'>> = {}): Doc<'campaigns'> {
	return {
		_id: 'cmp_x' as Id<'campaigns'>,
		_creationTime: Date.now(),
		name: 'Test campaign',
		status: 'sending',
		isABTest: false,
		statsSent: 0,
		statsFailed: 0,
		statsDelivered: 0,
		statsOpened: 0,
		statsClicked: 0,
		statsBounced: 0,
		statsHardBounced: 0,
		statsSoftBounced: 0,
		statsUnsubscribed: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as Doc<'campaigns'>;
}

describe('resolveAbFanout', () => {
	it('returns null for non-AB campaigns', () => {
		expect(resolveAbFanout(makeCampaign({ isABTest: false }))).toBeNull();
	});

	it('returns null when AB status is pending (cross-machine effect has not fired)', () => {
		const campaign = makeCampaign({
			isABTest: true,
			abTestStatus: 'pending',
			abTestConfig: {
				testType: 'subject',
				splitPercentage: 20,
				variantBSubject: 'B',
				winnerCriteria: 'manual',
			},
		});
		expect(resolveAbFanout(campaign)).toBeNull();
	});

	it('returns null when AB status is winner_selected (second-phase path)', () => {
		const campaign = makeCampaign({
			isABTest: true,
			abTestStatus: 'winner_selected',
			abWinner: 'A',
			abTestConfig: {
				testType: 'subject',
				splitPercentage: 20,
				variantBSubject: 'B',
				winnerCriteria: 'manual',
			},
		});
		expect(resolveAbFanout(campaign)).toBeNull();
	});

	it('returns the config when AB is actively testing', () => {
		const config = {
			testType: 'subject' as const,
			splitPercentage: 30,
			variantBSubject: 'Alt',
			winnerCriteria: 'open_rate' as const,
		};
		const campaign = makeCampaign({
			isABTest: true,
			abTestStatus: 'testing',
			abTestConfig: config,
		});
		const fanout = resolveAbFanout(campaign);
		expect(fanout).not.toBeNull();
		expect(fanout?.config.splitPercentage).toBe(30);
		expect(fanout?.config.testType).toBe('subject');
	});

	it('returns null when AB is testing but config is missing (defensive)', () => {
		const campaign = makeCampaign({
			isABTest: true,
			abTestStatus: 'testing',
			abTestConfig: undefined,
		});
		expect(resolveAbFanout(campaign)).toBeNull();
	});
});

// ─── testFractionForSplit ──────────────────────────────────────────────

describe('testFractionForSplit', () => {
	it('doubles the per-variant split into the cohort fraction', () => {
		expect(testFractionForSplit(20)).toBeCloseTo(0.4, 10);
		expect(testFractionForSplit(50)).toBeCloseTo(1.0, 10);
		expect(testFractionForSplit(10)).toBeCloseTo(0.2, 10);
	});

	it('clamps out-of-range inputs to [0, 1]', () => {
		expect(testFractionForSplit(0)).toBe(0);
		expect(testFractionForSplit(60)).toBe(1); // 1.2 → 1
		expect(testFractionForSplit(-5)).toBe(0);
	});
});

// ─── hashFraction ───────────────────────────────────────────────────────

describe('hashFraction', () => {
	it('is in [0, 1)', () => {
		for (let i = 0; i < 1000; i++) {
			const h = hashFraction('cmp_a', `ct_${i}`);
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(1);
		}
	});

	it('is deterministic — same (campaignId, contactId) gives the same value across runs', () => {
		const a = hashFraction('cmp_42', 'ct_99');
		const b = hashFraction('cmp_42', 'ct_99');
		expect(a).toBe(b);
	});

	it('varies with both inputs (different campaign or contact → different bucket)', () => {
		const base = hashFraction('cmp_a', 'ct_1');
		expect(hashFraction('cmp_b', 'ct_1')).not.toBe(base);
		expect(hashFraction('cmp_a', 'ct_2')).not.toBe(base);
	});

	it('is approximately uniform — cohort fraction converges on testFraction', () => {
		const N = 20_000;
		const testFraction = 0.4;
		let cohort = 0;
		for (let i = 0; i < N; i++) {
			if (hashFraction('cmp_dist', `ct_${i}`) < testFraction) cohort++;
		}
		const observed = cohort / N;
		// Within 3 percentage points of the configured fraction.
		expect(Math.abs(observed - testFraction)).toBeLessThan(0.03);
	});
});

// ─── variantForHash ─────────────────────────────────────────────────────

describe('variantForHash', () => {
	it('returns null (remainder) when h >= testFraction', () => {
		expect(variantForHash(0.4, 0.4)).toBeNull();
		expect(variantForHash(0.9, 0.4)).toBeNull();
	});

	it('returns null when testFraction is 0 (no cohort)', () => {
		expect(variantForHash(0, 0)).toBeNull();
	});

	it('assigns the lower half of the cohort interval to A, the upper half to B', () => {
		const testFraction = 0.4; // midpoint 0.2
		expect(variantForHash(0.0, testFraction)).toBe('A');
		expect(variantForHash(0.1, testFraction)).toBe('A');
		expect(variantForHash(0.19, testFraction)).toBe('A');
		expect(variantForHash(0.2, testFraction)).toBe('B');
		expect(variantForHash(0.3, testFraction)).toBe('B');
		expect(variantForHash(0.39, testFraction)).toBe('B');
	});

	it('balances A/B within the cohort across a large population', () => {
		const N = 20_000;
		const testFraction = 0.4;
		let a = 0;
		let b = 0;
		for (let i = 0; i < N; i++) {
			const variant = variantForHash(hashFraction('cmp_bal', `ct_${i}`), testFraction);
			if (variant === 'A') a++;
			else if (variant === 'B') b++;
		}
		const cohort = a + b;
		expect(cohort).toBeGreaterThan(0);
		// A and B each ~half of the cohort — within 6 points (finite-sample slack).
		expect(Math.abs(a / cohort - 0.5)).toBeLessThan(0.06);
		expect(Math.abs(b / cohort - 0.5)).toBeLessThan(0.06);
	});

	it('partitions the population disjointly and exhaustively at testFraction', () => {
		const N = 5_000;
		const testFraction = 0.4;
		let cohort = 0;
		let remainder = 0;
		for (let i = 0; i < N; i++) {
			const h = hashFraction('cmp_part', `ct_${i}`);
			const variant = variantForHash(h, testFraction);
			const isRemainder = h >= testFraction;
			// A contact is EITHER a cohort member (variant set) OR remainder — never both.
			if (variant === null) {
				expect(isRemainder).toBe(true);
				remainder++;
			} else {
				expect(isRemainder).toBe(false);
				cohort++;
			}
		}
		expect(cohort + remainder).toBe(N);
	});
});
