/**
 * The mix hash — uniformity, and the "a caller cannot steer the arm" property.
 *
 * A biased bucket space is the quietest possible defect: the realised share
 * would simply not equal the configured one, every rate the controller derives
 * would be computed over skewed denominators, and nothing would ever throw.
 */

import { describe, it, expect } from 'vitest';
import {
	armBucketFor,
	bucketFor,
	calibrationBucketFor,
	decideMixAssignment,
	hash32,
	MIX_BUCKET_SPACE,
} from '../adaptive_mix';
import { syntheticContactIds } from './fixtures';

const SAMPLE = 100_000;

/** Chi-square statistic of a bucket distribution over `binCount` equal bins. */
function chiSquareOfBuckets(buckets: ReadonlyArray<number | null>, binCount: number): number {
	const counts: number[] = Array.from({ length: binCount }, () => 0);
	const binWidth = MIX_BUCKET_SPACE / binCount;
	let total = 0;
	for (const bucket of buckets) {
		if (bucket === null) continue;
		const bin = Math.min(binCount - 1, Math.floor(bucket / binWidth));
		counts[bin] = (counts[bin] ?? 0) + 1;
		total += 1;
	}
	const expected = total / binCount;
	let statistic = 0;
	for (const count of counts) {
		const delta = count - expected;
		statistic += (delta * delta) / expected;
	}
	return statistic;
}

function chiSquare(keys: readonly string[], binCount: number): number {
	return chiSquareOfBuckets(
		keys.map((key) => bucketFor(key)),
		binCount
	);
}

describe('mix hash — uniformity', () => {
	it('distributes structured sequential ids uniformly (chi-square, 100 bins)', () => {
		const keys = syntheticContactIds(SAMPLE, 'seq');
		// df = 99. The 99.9th percentile of chi-square(99) is ~148; a hash that
		// leaves low-bit structure in sequential keys blows through this by
		// orders of magnitude.
		expect(chiSquare(keys, 100)).toBeLessThan(148);
	});

	it('distributes salted campaign keys uniformly', () => {
		// Through the module's OWN key builder, never a hand-rolled copy of it: a
		// test that rebuilds the salted key keeps passing after the key shape
		// changes, while testing a format the code no longer produces.
		const buckets = syntheticContactIds(SAMPLE, 'c').map((contactId, index) =>
			armBucketFor({ contactId, campaignId: `cmp-${index % 7}` }, 3)
		);
		expect(chiSquareOfBuckets(buckets, 100)).toBeLessThan(148);
	});

	it('distributes timestamp-shaped keys uniformly', () => {
		// The realistic adversarial input: ids minted in a tight loop share a
		// long common prefix and differ only in the last few characters.
		const base = 1_800_000_000_000;
		const keys = Array.from({ length: SAMPLE }, (_, index) => `k${base + index}`);
		expect(chiSquare(keys, 100)).toBeLessThan(148);
	});

	it('avalanches: a one-character change moves the bucket', () => {
		let moved = 0;
		const ids = syntheticContactIds(2000, 'av');
		for (const id of ids) {
			if (bucketFor(id) !== bucketFor(`${id}x`)) moved += 1;
		}
		// Collisions are expected at a rate of ~1/10000; anything systematic
		// would show up as a large number of unchanged buckets.
		expect(moved).toBeGreaterThan(ids.length - 5);
	});

	it('stays inside the bucket space and is an unsigned 32-bit value', () => {
		for (const id of syntheticContactIds(1000, 'rng')) {
			const bucket = bucketFor(id);
			expect(Number.isInteger(bucket)).toBe(true);
			expect(bucket).toBeGreaterThanOrEqual(0);
			expect(bucket).toBeLessThan(MIX_BUCKET_SPACE);
			const raw = hash32(id);
			expect(raw).toBeGreaterThanOrEqual(0);
			expect(raw).toBeLessThan(2 ** 32);
		}
	});

	it('is stable across calls and across key construction', () => {
		expect(hash32('stable-key')).toBe(hash32('stable-key'));
		expect(bucketFor(`a${'b'}c`)).toBe(bucketFor('abc'));
	});
});

describe('mix hash — a caller cannot steer the arm', () => {
	it('gives sequentially-minted ids the configured share, not a run of one arm', () => {
		// The steering attack that actually matters: a caller that can mint ids
		// in order must not be able to walk the bucket space and pick when it
		// crosses the threshold.
		const ids = syntheticContactIds(20_000, 'atk');
		const own = ids.filter(
			(contactId) =>
				decideMixAssignment({
					cell: { ownShare: 0.1, mixVersion: 1 },
					recipient: { contactId, campaignId: 'cmp-atk' },
				}).arm === 'own'
		).length;
		expect(Math.abs(own / ids.length - 0.1)).toBeLessThan(0.01);
	});

	it('does not order buckets monotonically with a monotone input', () => {
		const buckets = syntheticContactIds(5000, 'mono').map((id) => bucketFor(id));
		let ascending = 0;
		for (let index = 1; index < buckets.length; index += 1) {
			if ((buckets[index] ?? 0) > (buckets[index - 1] ?? 0)) ascending += 1;
		}
		// A monotone (or nearly monotone) mapping would sit near 1.0 or 0.0.
		expect(Math.abs(ascending / (buckets.length - 1) - 0.5)).toBeLessThan(0.05);
	});

	it('gives the caller no control through the campaign salt either', () => {
		// A caller that can choose the campaign id still cannot move a chosen
		// contact into a chosen arm without grinding: across many campaign ids
		// the contact's arm is a fair coin at s = 0.5.
		const campaigns = Array.from({ length: 4000 }, (_, index) => `cmp-${index}`);
		const own = campaigns.filter(
			(campaignId) =>
				decideMixAssignment({
					cell: { ownShare: 0.5, mixVersion: 1 },
					recipient: { contactId: 'target-contact', campaignId },
				}).arm === 'own'
		).length;
		expect(Math.abs(own / campaigns.length - 0.5)).toBeLessThan(0.03);
	});

	it('separates the arm and calibration partitions', () => {
		// Both draws come from the same key material and MUST NOT agree, or the
		// calibration slice would be a deterministic function of the arm. Asked
		// through the exported helpers so the two partitions cannot drift into
		// agreement behind the test's back.
		const ids = syntheticContactIds(20_000, 'sep');
		let agree = 0;
		for (const contactId of ids) {
			const recipient = { contactId, campaignId: 'cmp' };
			const armBucket = armBucketFor(recipient, 1);
			const sliceBucket = calibrationBucketFor(recipient, 1);
			if (armBucket === sliceBucket) agree += 1;
		}
		// Independent draws collide at ~1/10000.
		expect(agree).toBeLessThan(20);
	});

	it('keeps an identity-less recipient out of the calibration slice entirely', () => {
		// With neither a contact id nor a fallback key, BOTH partitions have no
		// key material. Neither may substitute the other's draw: a slice whose
		// membership were a function of the arm would hand the engagement-ratio
		// gate a one-armed sample (D8). Both simply return null, and the
		// decision fails closed.
		const recipient = {};
		expect(armBucketFor(recipient, 1)).toBeNull();
		expect(calibrationBucketFor(recipient, 1)).toBeNull();

		for (const mixVersion of [1, 2, 7, 9_999]) {
			for (const ownShare of [0.02, 0.25, 0.5, 0.9]) {
				const decision = decideMixAssignment({
					cell: { ownShare, mixVersion },
					recipient,
				});
				expect(decision.isCalibration).toBe(false);
				expect(decision.arm).toBe('reference');
				expect(decision.basis).toBe('unidentified');
			}
		}
	});
});
