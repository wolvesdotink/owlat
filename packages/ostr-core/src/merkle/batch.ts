/**
 * Evidence-batch commitments (plan §7.2).
 *
 * An observer never publishes evidence bundles — they contain the verbatim
 * signed headers of real users' mail. It publishes a `spam-report-batch`
 * attestation carrying counts plus a Merkle commitment over the per-report
 * bundle hashes. On appeal or monitor challenge, the challenger picks indices
 * against that fixed commitment and the observer must open exactly those
 * bundles to the adjudicating monitors.
 *
 * The commitment is an ordinary RFC 6962 tree whose leaves are the raw 32-byte
 * bundle hashes, so an opening is an ordinary inclusion proof: the observer
 * cannot choose which bundles exist after seeing the challenge, and cannot swap
 * one in, because both would move the root it already published on the log.
 *
 * One leaf per report: the batch size *is* `SpamReportBatchBody.reports`, and
 * {@link verifyBundleOpening} makes the caller pass that published count so an
 * observer cannot answer a challenge out of a batch of a different size.
 *
 * Sampling itself (which indices to ask for) is the challenger's business and
 * is deliberately not here — this module stays deterministic and has no
 * randomness.
 */

import { HASH_LENGTH, isHashList } from './hash.js';
import { toHex } from './hex.js';
import { verifyInclusion } from './proof.js';
import { MerkleTree } from './tree.js';

export interface BatchCommitment {
	/** Merkle root over the bundle hashes. */
	root: Buffer;
	/** The same root as lowercase hex — the form `SpamReportBatchBody.commitment` takes. */
	rootHex: string;
	/** Number of committed bundles; must equal the attestation's `reports`. */
	treeSize: number;
}

/** One opened bundle: enough for a monitor to check it alone (plan §7.2.4). */
export interface BundleOpening {
	index: number;
	treeSize: number;
	bundleHash: Buffer;
	proof: Buffer[];
}

export interface BundleOpeningInput {
	/** The committed root from the `spam-report-batch` attestation. */
	readonly root: Uint8Array;
	/**
	 * The attestation's `reports` count — the *published* batch size, which is
	 * the only authority on how many bundles the commitment covers.
	 */
	readonly committedSize: number;
	readonly index: number;
	/** Batch size the observer claims in its answer; must equal `committedSize`. */
	readonly treeSize: number;
	/** SHA-256 of the revealed evidence bundle, recomputed by the monitor. */
	readonly bundleHash: Uint8Array;
	readonly proof: readonly Uint8Array[];
}

function requireBundleHashes(bundleHashes: readonly Uint8Array[]): void {
	if (bundleHashes.length === 0) {
		throw new RangeError('a report batch must commit to at least one evidence bundle');
	}
	if (!isHashList(bundleHashes)) {
		throw new RangeError(`every bundle hash must be a ${HASH_LENGTH}-byte sha256 digest`);
	}
}

/**
 * Commit to a batch of evidence bundles, in the observer's own report order.
 * Order is part of the commitment: the same bundles in a different order
 * produce a different root, and an opening names an index in this order.
 *
 * @throws RangeError if the list is empty or any entry is not a 32-byte digest.
 * An empty batch is not a report batch — its commitment is the well-known
 * empty-tree root, which no opening can ever satisfy, so a `reports > 0`
 * attestation carrying it would be unsubstantiable by construction.
 */
export function commitToBundles(bundleHashes: readonly Uint8Array[]): BatchCommitment {
	requireBundleHashes(bundleHashes);
	const tree = MerkleTree.from(bundleHashes);
	const root = tree.root();
	return { root, rootHex: toHex(root), treeSize: tree.size };
}

/**
 * Open the bundles at `indices` against the commitment over `bundleHashes`.
 * The observer must pass the identical list it committed to; a different list
 * yields proofs that fail against the published root.
 *
 * @throws RangeError for an empty or malformed hash list, or an out-of-range
 * index.
 */
export function openBundles(
	bundleHashes: readonly Uint8Array[],
	indices: readonly number[]
): BundleOpening[] {
	requireBundleHashes(bundleHashes);
	const tree = MerkleTree.from(bundleHashes);
	return indices.map((index) => {
		if (!Number.isSafeInteger(index) || index < 0 || index >= tree.size) {
			throw new RangeError(`opening index must be an integer in [0, ${tree.size})`);
		}
		return {
			index,
			treeSize: tree.size,
			// Bounds-checked directly above; noUncheckedIndexedAccess cannot see it.
			bundleHash: Buffer.from(bundleHashes[index] as Uint8Array),
			proof: tree.inclusionProof(index, tree.size),
		};
	});
}

/**
 * Check one opening against the published root — the verification a monitor
 * runs during challenge sampling, holding nothing but the attestation and what
 * the observer just handed over. A forged bundle (wrong hash), a substituted
 * position (wrong index) or a batch that was never committed (wrong root or
 * size) all return `false`.
 *
 * `committedSize` must come from the signed attestation (`reports`), never from
 * the observer's answer: an inclusion proof binds the leaf, the index and the
 * root, but *not* the tree size, so an opening built against a size the
 * observer invented verifies happily on its own. Checking the two sizes agree
 * here is what ties every opening to the batch the observer actually published,
 * and what makes challenge indices sampled from `[0, reports)` meaningful
 * (§7.2.4, §7.3).
 */
export function verifyBundleOpening(input: BundleOpeningInput): boolean {
	const { root, committedSize, index, treeSize, bundleHash, proof } = input;
	if (!Number.isSafeInteger(committedSize) || committedSize !== treeSize) return false;
	if (bundleHash.length !== HASH_LENGTH) return false;
	return verifyInclusion({ leaf: bundleHash, index, treeSize, proof, root });
}
