/**
 * Proof properties, checked exhaustively over every tree size up to 64 and
 * every (old, new) prefix pair — the sizes where all the awkward shapes
 * (non-power-of-two splits, right-edge subtrees, single-leaf trees) occur.
 *
 * Every negative case is a real attack: a substituted leaf, a moved index, a
 * mutated path element, a truncated or padded path, and a proof replayed
 * against another log's root.
 */

import { describe, expect, it } from 'vitest';
import { sha256 } from '../../crypto.js';
import { emptyTreeRoot, leafHash } from '../hash.js';
import { verifyConsistency, verifyInclusion } from '../proof.js';
import { MerkleTree } from '../tree.js';

const MAX = 64;
const leafFor = (i: number): Buffer => Buffer.from(`ostr-entry-${i}`, 'utf8');
const leaves = Array.from({ length: MAX }, (_, i) => leafFor(i));
const tree = MerkleTree.from(leaves);
/** A second log over different data — same shape, different history. */
const otherTree = MerkleTree.from(leaves.map((leaf) => Buffer.concat([leaf, Buffer.from('!')])));

const flipFirstByte = (buffer: Buffer): Buffer => {
	const copy = Buffer.from(buffer);
	copy[0] = (copy[0]! ^ 0x01) & 0xff;
	return copy;
};

describe('inclusion proofs', () => {
	it('proves every leaf of every tree size 1..64', () => {
		for (let treeSize = 1; treeSize <= MAX; treeSize++) {
			const root = tree.root(treeSize);
			for (let index = 0; index < treeSize; index++) {
				const proof = tree.inclusionProof(index, treeSize);
				expect(verifyInclusion({ leaf: leafFor(index), index, treeSize, proof, root })).toBe(true);
			}
		}
	});

	it('has a path length of ceil(log2(treeSize)) at worst', () => {
		for (let treeSize = 1; treeSize <= MAX; treeSize++) {
			const depth = Math.ceil(Math.log2(treeSize));
			for (let index = 0; index < treeSize; index++) {
				expect(tree.inclusionProof(index, treeSize).length).toBeLessThanOrEqual(depth);
			}
		}
	});

	it('rejects a substituted leaf', () => {
		const treeSize = 13;
		const root = tree.root(treeSize);
		for (let index = 0; index < treeSize; index++) {
			const proof = tree.inclusionProof(index, treeSize);
			expect(verifyInclusion({ leaf: Buffer.from('forged'), index, treeSize, proof, root })).toBe(
				false
			);
		}
	});

	it('rejects a leaf hash presented as leaf data (0x00/0x01 domain separation)', () => {
		const treeSize = 9;
		const proof = tree.inclusionProof(4, treeSize);
		expect(
			verifyInclusion({
				leaf: leafHash(leafFor(4)),
				index: 4,
				treeSize,
				proof,
				root: tree.root(treeSize),
			})
		).toBe(false);
	});

	it('rejects a proof replayed at a different index', () => {
		const treeSize = 21;
		const root = tree.root(treeSize);
		for (let index = 0; index < treeSize; index++) {
			const proof = tree.inclusionProof(index, treeSize);
			for (const wrong of [index - 1, index + 1, treeSize - 1 - index]) {
				if (wrong === index || wrong < 0 || wrong >= treeSize) continue;
				expect(verifyInclusion({ leaf: leafFor(index), index: wrong, treeSize, proof, root })).toBe(
					false
				);
			}
		}
	});

	it('rejects a mutated path element', () => {
		const treeSize = 30;
		const root = tree.root(treeSize);
		for (let index = 0; index < treeSize; index++) {
			const proof = tree.inclusionProof(index, treeSize);
			for (let i = 0; i < proof.length; i++) {
				const mutated = [...proof];
				mutated[i] = flipFirstByte(proof[i]!);
				expect(
					verifyInclusion({ leaf: leafFor(index), index, treeSize, proof: mutated, root })
				).toBe(false);
			}
		}
	});

	it('rejects truncated, padded and reordered paths', () => {
		const treeSize = 27;
		const index = 11;
		const root = tree.root(treeSize);
		const proof = tree.inclusionProof(index, treeSize);
		const base = { leaf: leafFor(index), index, treeSize, root };
		expect(verifyInclusion({ ...base, proof: proof.slice(1) })).toBe(false);
		expect(verifyInclusion({ ...base, proof: proof.slice(0, -1) })).toBe(false);
		expect(verifyInclusion({ ...base, proof: [...proof, sha256('extra')] })).toBe(false);
		expect(verifyInclusion({ ...base, proof: [...proof].reverse() })).toBe(false);
		expect(verifyInclusion({ ...base, proof: [] })).toBe(false);
	});

	it('rejects a wrong root, a wrong tree size and out-of-range coordinates', () => {
		const treeSize = 16;
		const index = 3;
		const proof = tree.inclusionProof(index, treeSize);
		const base = { leaf: leafFor(index), index, treeSize, proof };
		expect(verifyInclusion({ ...base, root: otherTree.root(treeSize) })).toBe(false);
		expect(verifyInclusion({ ...base, root: flipFirstByte(tree.root(treeSize)) })).toBe(false);
		expect(verifyInclusion({ ...base, treeSize: 17, root: tree.root(17) })).toBe(false);
		expect(verifyInclusion({ ...base, index: 16, root: tree.root(treeSize) })).toBe(false);
		expect(verifyInclusion({ ...base, index: -1, root: tree.root(treeSize) })).toBe(false);
		expect(verifyInclusion({ ...base, index: 1.5, root: tree.root(treeSize) })).toBe(false);
		expect(verifyInclusion({ ...base, treeSize: 0, root: emptyTreeRoot() })).toBe(false);
	});

	it('rejects malformed hash lengths instead of throwing', () => {
		const treeSize = 8;
		const index = 2;
		const proof = tree.inclusionProof(index, treeSize);
		const base = { leaf: leafFor(index), index, treeSize };
		expect(verifyInclusion({ ...base, proof, root: Buffer.alloc(31) })).toBe(false);
		expect(
			verifyInclusion({ ...base, proof: [Buffer.alloc(16), ...proof.slice(1)], root: tree.root(8) })
		).toBe(false);
	});
});

describe('consistency proofs', () => {
	it('holds for every (old, new) prefix pair up to 64', () => {
		for (let newSize = 0; newSize <= MAX; newSize++) {
			const newRoot = tree.root(newSize);
			for (let oldSize = 0; oldSize <= newSize; oldSize++) {
				const proof = tree.consistencyProof(oldSize, newSize);
				expect(
					verifyConsistency({
						oldSize,
						newSize,
						oldRoot: tree.root(oldSize),
						newRoot,
						proof,
					})
				).toBe(true);
			}
		}
	});

	it('rejects a tree that is not an extension of the old one', () => {
		for (let oldSize = 1; oldSize <= 16; oldSize++) {
			for (let newSize = oldSize + 1; newSize <= 20; newSize++) {
				const proof = tree.consistencyProof(oldSize, newSize);
				// Same sizes, same proof, a different history: forking is detected.
				expect(
					verifyConsistency({
						oldSize,
						newSize,
						oldRoot: otherTree.root(oldSize),
						newRoot: otherTree.root(newSize),
						proof,
					})
				).toBe(false);
				expect(
					verifyConsistency({
						oldSize,
						newSize,
						oldRoot: tree.root(oldSize),
						newRoot: otherTree.root(newSize),
						proof,
					})
				).toBe(false);
			}
		}
	});

	it('rejects mutated, truncated and padded paths', () => {
		for (const [oldSize, newSize] of [
			[3, 7],
			[6, 8],
			[7, 64],
			[13, 21],
		] as const) {
			const proof = tree.consistencyProof(oldSize, newSize);
			const base = {
				oldSize,
				newSize,
				oldRoot: tree.root(oldSize),
				newRoot: tree.root(newSize),
			};
			expect(verifyConsistency({ ...base, proof })).toBe(true);
			for (let i = 0; i < proof.length; i++) {
				const mutated = [...proof];
				mutated[i] = flipFirstByte(proof[i]!);
				expect(verifyConsistency({ ...base, proof: mutated })).toBe(false);
			}
			expect(verifyConsistency({ ...base, proof: proof.slice(1) })).toBe(false);
			expect(verifyConsistency({ ...base, proof: [...proof, sha256('extra')] })).toBe(false);
			expect(verifyConsistency({ ...base, proof: [] })).toBe(false);
		}
	});

	it('rejects a shrinking log and mismatched sizes', () => {
		const proof = tree.consistencyProof(4, 12);
		const base = { oldRoot: tree.root(4), newRoot: tree.root(12), proof };
		expect(verifyConsistency({ ...base, oldSize: 12, newSize: 4 })).toBe(false);
		expect(verifyConsistency({ ...base, oldSize: 5, newSize: 12 })).toBe(false);
		expect(verifyConsistency({ ...base, oldSize: -1, newSize: 12 })).toBe(false);
		// A proof binds the two *roots*; claiming a different new size does not
		// help unless the corresponding root also verifies.
		expect(verifyConsistency({ ...base, oldSize: 4, newSize: 13, newRoot: tree.root(13) })).toBe(
			false
		);
	});

	it('requires equal roots when the size did not change', () => {
		const oldRoot = tree.root(9);
		expect(
			verifyConsistency({ oldSize: 9, newSize: 9, oldRoot, newRoot: oldRoot, proof: [] })
		).toBe(true);
		// Equivocation: two different roots claimed for the same tree size.
		expect(
			verifyConsistency({
				oldSize: 9,
				newSize: 9,
				oldRoot,
				newRoot: otherTree.root(9),
				proof: [],
			})
		).toBe(false);
		expect(
			verifyConsistency({
				oldSize: 9,
				newSize: 9,
				oldRoot,
				newRoot: oldRoot,
				proof: [sha256('extra')],
			})
		).toBe(false);
	});

	it('accepts the empty tree as a prefix only with the empty root', () => {
		expect(
			verifyConsistency({
				oldSize: 0,
				newSize: 5,
				oldRoot: emptyTreeRoot(),
				newRoot: tree.root(5),
				proof: [],
			})
		).toBe(true);
		expect(
			verifyConsistency({
				oldSize: 0,
				newSize: 5,
				oldRoot: tree.root(1),
				newRoot: tree.root(5),
				proof: [],
			})
		).toBe(false);
		expect(
			verifyConsistency({
				oldSize: 0,
				newSize: 5,
				oldRoot: emptyTreeRoot(),
				newRoot: tree.root(5),
				proof: [sha256('extra')],
			})
		).toBe(false);
	});

	it('rejects malformed hash lengths instead of throwing', () => {
		const proof = tree.consistencyProof(3, 9);
		const base = { oldSize: 3, newSize: 9, oldRoot: tree.root(3), newRoot: tree.root(9) };
		expect(verifyConsistency({ ...base, proof, oldRoot: Buffer.alloc(8) })).toBe(false);
		expect(verifyConsistency({ ...base, proof, newRoot: Buffer.alloc(64) })).toBe(false);
		expect(verifyConsistency({ ...base, proof: [Buffer.alloc(31), ...proof.slice(1)] })).toBe(
			false
		);
	});
});
