/**
 * Standalone proof verification — RFC 9162 §2.1.3.2 (inclusion) and §2.1.4.2
 * (consistency), which are the verification counterparts of RFC 6962 §2.1's
 * PATH and PROOF.
 *
 * Nothing here touches a tree: a monitor or a client checks a proof with the
 * leaf, the sizes, the path and the root(s) it already has. That asymmetry is
 * the point of a transparency log — the verifier must never have to trust, or
 * even talk to, the party that produced the proof.
 *
 * Every function returns a boolean and throws nothing: input from a log is
 * untrusted, so malformed sizes, wrong-length hashes and paths of the wrong
 * length are all simply `false`. Proof length is checked implicitly by the
 * RFC's own loop — a path with an element added or removed cannot end with
 * `sn === 0`.
 */

import {
	emptyTreeRoot,
	HASH_LENGTH,
	hashEquals,
	isHashList,
	isPowerOfTwo,
	leafHash,
	nodeHash,
} from './hash.js';

export interface InclusionProofInput {
	/** Raw leaf bytes; hashed here so callers cannot substitute a node hash. */
	readonly leaf: Uint8Array;
	readonly index: number;
	readonly treeSize: number;
	readonly proof: readonly Uint8Array[];
	/** Root of the tree of exactly `treeSize` leaves, from a verified STH. */
	readonly root: Uint8Array;
}

export interface ConsistencyProofInput {
	readonly oldSize: number;
	readonly newSize: number;
	readonly oldRoot: Uint8Array;
	readonly newRoot: Uint8Array;
	readonly proof: readonly Uint8Array[];
}

function isSize(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Verify that `leaf` sits at `index` of the tree of size `treeSize` whose root
 * is `root`. Verifies the *leaf bytes*, not a leaf hash: a proof for an
 * interior node cannot be passed off as a proof for a leaf.
 *
 * What is bound is the leaf, the index and the root — *not* `treeSize`: a proof
 * built for one size verifies against that size's root whatever size the caller
 * claims alongside it. `treeSize` and `root` must therefore come from the same
 * signed source (an STH, or the batch size published in an attestation — see
 * `verifyBundleOpening`), never from the response that carried the proof.
 */
export function verifyInclusion(input: InclusionProofInput): boolean {
	const { leaf, index, treeSize, proof, root } = input;
	if (!isSize(index) || !isSize(treeSize) || index >= treeSize) return false;
	if (root.length !== HASH_LENGTH || !isHashList(proof)) return false;

	// RFC 9162 §2.1.3.2. `fn` walks the leaf index up the tree, `sn` the index
	// of the last leaf; `fn === sn` marks the right edge, where the sibling is
	// a shorter subtree and the node hangs on the left.
	let fn = index;
	let sn = treeSize - 1;
	let r: Buffer = leafHash(leaf);
	for (const p of proof) {
		if (sn === 0) return false;
		if (fn % 2 === 1 || fn === sn) {
			r = nodeHash(p, r);
			if (fn % 2 === 0) {
				while (fn !== 0 && fn % 2 === 0) {
					fn = Math.floor(fn / 2);
					sn = Math.floor(sn / 2);
				}
			}
		} else {
			r = nodeHash(r, p);
		}
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}
	return sn === 0 && hashEquals(r, root);
}

/**
 * Verify that the tree of size `newSize` with root `newRoot` is an append-only
 * extension of the tree of size `oldSize` with root `oldRoot`.
 *
 * Boundary cases, all with an empty proof: `oldSize === 0` requires `oldRoot`
 * to be the empty-tree root (a log cannot claim an arbitrary root for an empty
 * history), and `oldSize === newSize` requires the two roots to be equal —
 * which is exactly the equivocation check monitors run when they gossip STHs.
 *
 * What is bound is the pair of *roots*: a caller that misreports a size but
 * supplies roots for which the path does verify learns nothing it did not
 * already have. Sizes must therefore come from a signed STH, not from the same
 * response that carried the proof.
 */
export function verifyConsistency(input: ConsistencyProofInput): boolean {
	const { oldSize, newSize, oldRoot, newRoot, proof } = input;
	if (!isSize(oldSize) || !isSize(newSize) || oldSize > newSize) return false;
	if (oldRoot.length !== HASH_LENGTH || newRoot.length !== HASH_LENGTH) return false;
	if (!isHashList(proof)) return false;

	if (oldSize === 0) return proof.length === 0 && hashEquals(oldRoot, emptyTreeRoot());
	if (oldSize === newSize) return proof.length === 0 && hashEquals(oldRoot, newRoot);

	// RFC 9162 §2.1.4.2. When `oldSize` is a power of two the old root is a
	// node of the new tree and is not transmitted; the verifier supplies it.
	const path = isPowerOfTwo(oldSize) ? [Buffer.from(oldRoot), ...proof] : [...proof];
	const seed = path[0];
	if (seed === undefined) return false;

	let fn = oldSize - 1;
	let sn = newSize - 1;
	while (fn % 2 === 1) {
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}

	let fr: Buffer = Buffer.from(seed);
	let sr: Buffer = Buffer.from(seed);
	for (const c of path.slice(1)) {
		if (sn === 0) return false;
		if (fn % 2 === 1 || fn === sn) {
			fr = nodeHash(c, fr);
			sr = nodeHash(c, sr);
			if (fn % 2 === 0) {
				while (fn !== 0 && fn % 2 === 0) {
					fn = Math.floor(fn / 2);
					sn = Math.floor(sn / 2);
				}
			}
		} else {
			sr = nodeHash(sr, c);
		}
		fn = Math.floor(fn / 2);
		sn = Math.floor(sn / 2);
	}
	return sn === 0 && hashEquals(fr, oldRoot) && hashEquals(sr, newRoot);
}
