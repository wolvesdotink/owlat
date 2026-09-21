/**
 * Append-only Merkle tree over leaf byte-buffers — the in-memory core of an
 * RFC 9162-shaped log (plan §9.1, D1).
 *
 * The tree is pure state: no I/O, no clock, no persistence policy. A log
 * server keeps the ordered leaves durably and rebuilds the tree with
 * {@link MerkleTree.from}; the root, the inclusion path and the consistency
 * path are all recomputed from those leaves, so nothing derived needs to be
 * stored (or trusted) at rest. Only leaf *hashes* are kept here — the leaf
 * bytes are the server's copy of state, and mirroring them would double the
 * memory of a long-lived log for nothing.
 *
 * Proof *generation* lives here because it needs the leaves. Proof
 * *verification* deliberately does not — see `./proof.js`, which takes only
 * the proof, the leaf, the sizes and the roots.
 *
 * Every returned buffer is a copy. Handing out a live reference into
 * `leafHashes` or the subtree cache would let a caller mutating a proof
 * element rewrite the log's in-memory history.
 *
 * Complexity: `append` is O(1); `root`, `inclusionProof` and `consistencyProof`
 * are O(log n) hashes after the first call, because every complete (perfect,
 * aligned) subtree is immutable once its leaves exist and is memoized. The
 * cache holds O(n) entries and is never invalidated.
 */

import { emptyTreeRoot, leafHash, nodeHash, splitPoint } from './hash.js';

function requireIndex(name: string, value: number, upperExclusive: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value >= upperExclusive) {
		throw new RangeError(`${name} must be an integer in [0, ${upperExclusive})`);
	}
}

function requireSize(name: string, value: number, upperInclusive: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > upperInclusive) {
		throw new RangeError(`${name} must be an integer in [0, ${upperInclusive}]`);
	}
}

export class MerkleTree {
	private readonly leafHashes: Buffer[] = [];
	/** `${start}:${width}` → MTH of a perfect, aligned subtree. */
	private readonly subtreeCache = new Map<string, Buffer>();

	/** Rebuild a tree from its stored leaves, in log order. */
	static from(leaves: readonly Uint8Array[]): MerkleTree {
		const tree = new MerkleTree();
		for (const leaf of leaves) tree.append(leaf);
		return tree;
	}

	/** Number of leaves currently in the tree. */
	get size(): number {
		return this.leafHashes.length;
	}

	/**
	 * Append a leaf; returns its permanent zero-based index. The leaf is hashed
	 * immediately, so later mutation of the caller's buffer cannot rewrite what
	 * the tree committed to.
	 */
	append(leaf: Uint8Array): number {
		const index = this.leafHashes.length;
		this.leafHashes.push(leafHash(leaf));
		return index;
	}

	/** The leaf hash (`SHA-256(0x00 || leaf)`) at `index`, copied. */
	leafHashAt(index: number): Buffer {
		requireIndex('index', index, this.size);
		// Bounds-checked directly above; noUncheckedIndexedAccess cannot see it.
		return Buffer.from(this.leafHashes[index] as Buffer);
	}

	/**
	 * MTH of the first `treeSize` leaves (default: the whole tree). Historic
	 * roots are needed to sign an STH for a size already served and to check a
	 * consistency proof the log itself produced.
	 */
	root(treeSize: number = this.size): Buffer {
		requireSize('treeSize', treeSize, this.size);
		if (treeSize === 0) return emptyTreeRoot();
		return Buffer.from(this.mth(0, treeSize));
	}

	/**
	 * RFC 6962 §2.1.1 PATH(index, D[treeSize]): the sibling hashes from the
	 * leaf up to the root of the tree of size `treeSize`, deepest first.
	 * Empty for the single-leaf tree, where the leaf hash *is* the root.
	 */
	inclusionProof(index: number, treeSize: number = this.size): Buffer[] {
		requireSize('treeSize', treeSize, this.size);
		requireIndex('index', index, treeSize);

		const path: Buffer[] = [];
		let start = 0;
		let n = treeSize;
		let m = index;
		while (n > 1) {
			const k = splitPoint(n);
			if (m < k) {
				path.push(Buffer.from(this.mth(start + k, n - k)));
				n = k;
			} else {
				path.push(Buffer.from(this.mth(start, k)));
				start += k;
				n -= k;
				m -= k;
			}
		}
		return path.reverse();
	}

	/**
	 * RFC 6962 §2.1.2 PROOF(oldSize, D[newSize]): proves the tree of size
	 * `newSize` contains the tree of size `oldSize` as a prefix — i.e. that the
	 * log only ever appended.
	 *
	 * Empty when `oldSize` is 0 (every tree extends the empty tree) or equals
	 * `newSize` (the roots must simply match).
	 */
	consistencyProof(oldSize: number, newSize: number = this.size): Buffer[] {
		requireSize('newSize', newSize, this.size);
		requireSize('oldSize', oldSize, newSize);
		if (oldSize === 0 || oldSize === newSize) return [];

		const proof: Buffer[] = [];
		let start = 0;
		let n = newSize;
		let m = oldSize;
		// SUBPROOF's `b`: the old tree is still an exact prefix of the range.
		let complete = true;
		while (m !== n) {
			const k = splitPoint(n);
			if (m <= k) {
				proof.push(Buffer.from(this.mth(start + k, n - k)));
				n = k;
			} else {
				proof.push(Buffer.from(this.mth(start, k)));
				start += k;
				n -= k;
				m -= k;
				complete = false;
			}
		}
		// SUBPROOF(m, D[m], false) = { MTH(D[m]) }: the old root is only sent
		// when it is not already an implied node of the new tree.
		if (!complete) proof.push(Buffer.from(this.mth(start, n)));
		return proof.reverse();
	}

	/**
	 * MTH of the leaf range `[start, start + width)`; `width >= 1`.
	 * Returns the tree's own buffer — every public caller copies before
	 * handing it out.
	 */
	private mth(start: number, width: number): Buffer {
		if (width === 1) return this.leafHashes[start] as Buffer;

		const k = splitPoint(width);
		// A perfect, aligned subtree is immutable once its leaves exist.
		const cacheable = width === k * 2 && start % width === 0;
		const key = cacheable ? `${start}:${width}` : '';
		if (cacheable) {
			const cached = this.subtreeCache.get(key);
			if (cached) return cached;
		}

		const hash = nodeHash(this.mth(start, k), this.mth(start + k, width - k));
		if (cacheable) this.subtreeCache.set(key, hash);
		return hash;
	}
}
