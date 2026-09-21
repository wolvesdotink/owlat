/**
 * Evidence-batch commitments and challenge sampling (plan §7.2.4): the
 * observer commits once, the challenger picks indices afterwards, and the
 * monitor verifies each opening against the published root and the published
 * report count alone.
 */

import { describe, expect, it } from 'vitest';
import { sha256 } from '../../crypto.js';
import {
	commitToBundles,
	openBundles,
	verifyBundleOpening,
	type BundleOpening,
	type BundleOpeningInput,
} from '../batch.js';
import { MerkleTree } from '../tree.js';

const bundleHash = (i: number): Buffer => sha256(`evidence-bundle-${i}`);
const batchOf = (n: number): Buffer[] => Array.from({ length: n }, (_, i) => bundleHash(i));

/** A monitor's check: the root and the report count come from the attestation. */
const check = (
	root: Uint8Array,
	committedSize: number,
	opening: BundleOpening,
	patch: Partial<BundleOpeningInput> = {}
): boolean => verifyBundleOpening({ root, committedSize, ...opening, ...patch });

/**
 * Pinned wire vector, computed outside this package: five fixed bundle hashes
 * as raw 32-byte leaves of an RFC 6962 tree. It pins what actually goes into a
 * published `spam-report-batch` commitment — bundle hashes are the leaves
 * themselves, hashed with the 0x00 leaf prefix, not wrapped in a JCS envelope.
 */
const VECTOR = {
	bundles: [
		'59603384366ceba9647adc86b1b6a3a4efa4855de881a9e780a314875dd4a2f2',
		'8c111e4740bc898f0086ffe0d7485bc06ab14c31dba65a510e59eb5d712e5fa6',
		'1592a0a42d44cbaa2c7ad9fa68af951fc7127c845e366d8d0cda0b1a2dea781d',
		'8dc37fa66a7bd84f11678824bc3abab531a75dd9d8e0eb3471e2b795e9b29d6c',
		'8896f3d439528433db3bb3a1e1a8b45151e7210a74446ec6bebc58eeae360149',
	],
	root: '293fc88e468c3b88481745b1ab7f894e1c9626db5dc9e7cb35c06bb76d38b0e4',
};

describe('commitToBundles', () => {
	it('matches the pinned commitment vector', () => {
		const bundles = VECTOR.bundles.map((hex) => Buffer.from(hex, 'hex'));
		// The inputs are the sha256 digests of these strings; pinned as hex so a
		// change to either side of the seam is visible.
		expect(bundles).toEqual([0, 1, 2, 3, 4].map((i) => sha256(`ostr-evidence-bundle-${i}`)));
		const commitment = commitToBundles(bundles);
		expect(commitment.rootHex).toBe(VECTOR.root);
		expect(commitment.root.toString('hex')).toBe(VECTOR.root);
		expect(commitment.treeSize).toBe(5);
	});

	it('is the RFC 6962 root over the bundle hashes as leaves', () => {
		const bundles = batchOf(9);
		const commitment = commitToBundles(bundles);
		expect(commitment.treeSize).toBe(9);
		expect(commitment.root).toEqual(MerkleTree.from(bundles).root());
		expect(commitment.rootHex).toBe(commitment.root.toString('hex'));
	});

	it('is deterministic and order-sensitive', () => {
		const bundles = batchOf(6);
		expect(commitToBundles(bundles).root).toEqual(commitToBundles([...bundles]).root);
		const swapped = [...bundles];
		[swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
		expect(commitToBundles(swapped).root).not.toEqual(commitToBundles(bundles).root);
	});

	it('refuses an empty batch, whose commitment no opening could satisfy', () => {
		expect(() => commitToBundles([])).toThrow(RangeError);
		expect(() => openBundles([], [0])).toThrow(RangeError);
	});

	it('rejects entries that are not sha256 digests', () => {
		expect(() => commitToBundles([Buffer.from('short')])).toThrow(RangeError);
		expect(() => openBundles([Buffer.alloc(33)], [0])).toThrow(RangeError);
	});
});

describe('openBundles / verifyBundleOpening', () => {
	it('opens every index of every batch size 1..40', () => {
		for (let size = 1; size <= 40; size++) {
			const bundles = batchOf(size);
			const { root } = commitToBundles(bundles);
			const indices = Array.from({ length: size }, (_, i) => i);
			for (const opening of openBundles(bundles, indices)) {
				expect(opening.bundleHash).toEqual(bundleHash(opening.index));
				expect(opening.treeSize).toBe(size);
				expect(check(root, size, opening)).toBe(true);
			}
		}
	});

	it('opens only the sampled indices, in the order asked', () => {
		const bundles = batchOf(32);
		const sample = [29, 3, 17, 0];
		const openings = openBundles(bundles, sample);
		expect(openings.map((o) => o.index)).toEqual(sample);
	});

	it('rejects a forged bundle at a committed index', () => {
		const bundles = batchOf(16);
		const { root } = commitToBundles(bundles);
		const [opening] = openBundles(bundles, [7]);
		expect(check(root, 16, opening!, { bundleHash: sha256('fabricated-report') })).toBe(false);
	});

	it('rejects an opening replayed at the wrong index', () => {
		const bundles = batchOf(16);
		const { root } = commitToBundles(bundles);
		const [opening] = openBundles(bundles, [7]);
		expect(check(root, 16, opening!, { index: 8 })).toBe(false);
		expect(check(root, 16, opening!, { index: 6 })).toBe(false);
		expect(check(root, 16, opening!, { index: 16 })).toBe(false);
	});

	it('rejects openings against a different batch, size or root', () => {
		const bundles = batchOf(16);
		const other = batchOf(16).map((h) => sha256(h));
		const { root } = commitToBundles(bundles);
		const [opening] = openBundles(bundles, [5]);
		expect(check(commitToBundles(other).root, 16, opening!)).toBe(false);
		expect(check(root, 17, opening!, { treeSize: 17 })).toBe(false);
		expect(check(root, 16, opening!, { proof: [] })).toBe(false);
	});

	it('rejects a batch size the observer invented for the challenge', () => {
		// The attestation says 3 reports; the observer answers out of a 4-leaf
		// batch. The opening is internally valid — only the published count
		// exposes it.
		const bundles = batchOf(3);
		const { root, treeSize } = commitToBundles(bundles);
		const [opening] = openBundles(bundles, [0]);
		expect(check(root, treeSize, opening!)).toBe(true);
		expect(check(root, 4, opening!)).toBe(false);
		expect(check(root, treeSize, opening!, { treeSize: 4 })).toBe(false);
		expect(check(root, Number.NaN, opening!)).toBe(false);
		expect(check(root, 1.5, opening!)).toBe(false);
	});

	it('rejects a bundle the observer never committed to', () => {
		const bundles = batchOf(10);
		const { root, treeSize } = commitToBundles(bundles);
		// The observer adds an eleventh report after publishing the commitment.
		const extended = [...bundles, sha256('late-addition')];
		const [opening] = openBundles(extended, [10]);
		expect(check(root, treeSize, opening!)).toBe(false);
		expect(
			verifyBundleOpening({
				root,
				committedSize: treeSize,
				index: 10,
				treeSize,
				bundleHash: sha256('late-addition'),
				proof: opening!.proof,
			})
		).toBe(false);
	});

	it('rejects malformed openings instead of throwing', () => {
		const bundles = batchOf(8);
		const { root } = commitToBundles(bundles);
		const [opening] = openBundles(bundles, [1]);
		expect(check(root, 8, opening!, { bundleHash: Buffer.alloc(31) })).toBe(false);
		expect(check(Buffer.alloc(0), 8, opening!)).toBe(false);
		expect(() => openBundles(bundles, [8])).toThrow(RangeError);
		expect(() => openBundles(bundles, [-1])).toThrow(RangeError);
	});

	it('copies the opened bundle hash out of the committed list', () => {
		const bundles = batchOf(4);
		const [opening] = openBundles(bundles, [2]);
		opening!.bundleHash[0] = (opening!.bundleHash[0]! ^ 0xff) & 0xff;
		expect(bundles[2]).toEqual(bundleHash(2));
	});
});
