/**
 * Tree mechanics: append-only indexing, historic roots, rebuild-from-leaves
 * and argument validation.
 */

import { describe, expect, it } from 'vitest';
import { emptyTreeRoot, leafHash, nodeHash } from '../hash.js';
import { verifyConsistency, verifyInclusion } from '../proof.js';
import { MerkleTree } from '../tree.js';

const leafFor = (i: number): Buffer => Buffer.from(`ostr-leaf-${i}`, 'utf8');
const leavesUpTo = (n: number): Buffer[] => Array.from({ length: n }, (_, i) => leafFor(i));

/**
 * MTH straight from RFC 6962 §2.1, with no subtree memoization — an
 * independent check that the tree's cache never returns a stale node.
 */
const naiveRoot = (leaves: readonly Buffer[]): Buffer => {
	if (leaves.length === 0) return emptyTreeRoot();
	if (leaves.length === 1) return leafHash(leaves[0]!);
	let k = 1;
	while (k * 2 < leaves.length) k *= 2;
	return nodeHash(naiveRoot(leaves.slice(0, k)), naiveRoot(leaves.slice(k)));
};

describe('MerkleTree', () => {
	it('starts empty with the RFC 6962 empty root', () => {
		const tree = new MerkleTree();
		expect(tree.size).toBe(0);
		expect(tree.root()).toEqual(emptyTreeRoot());
	});

	it('returns consecutive indices from append', () => {
		const tree = new MerkleTree();
		expect(leavesUpTo(5).map((leaf) => tree.append(leaf))).toEqual([0, 1, 2, 3, 4]);
		expect(tree.size).toBe(5);
	});

	it('is the leaf hash itself for a single-leaf tree', () => {
		const tree = MerkleTree.from([leafFor(0)]);
		expect(tree.root()).toEqual(leafHash(leafFor(0)));
		expect(tree.inclusionProof(0, 1)).toEqual([]);
	});

	it('rebuilds byte-identically from the leaves the server stored', () => {
		const tree = MerkleTree.from(leavesUpTo(37));
		const rebuilt = MerkleTree.from(leavesUpTo(37));
		expect(rebuilt.size).toBe(37);
		expect(rebuilt.root()).toEqual(tree.root());
		for (let size = 0; size <= 37; size++) {
			expect(rebuilt.root(size)).toEqual(tree.root(size));
		}
	});

	it('keeps historic roots stable as the tree grows', () => {
		const growing = new MerkleTree();
		const snapshots: Buffer[] = [];
		for (let i = 0; i < 20; i++) {
			growing.append(leafFor(i));
			snapshots.push(growing.root());
		}
		for (let size = 1; size <= 20; size++) {
			expect(growing.root(size)).toEqual(snapshots[size - 1]);
			expect(MerkleTree.from(leavesUpTo(size)).root()).toEqual(snapshots[size - 1]);
		}
	});

	it('hashes on append so a mutated caller buffer cannot rewrite history', () => {
		const mutable = Buffer.from('original', 'utf8');
		const tree = MerkleTree.from([mutable]);
		const rootBefore = tree.root();
		mutable.write('tampered');
		expect(tree.root()).toEqual(rootBefore);
		expect(tree.leafHashAt(0)).toEqual(leafHash(Buffer.from('original', 'utf8')));
	});

	it('exposes leaf hashes for the committed leaves', () => {
		const tree = MerkleTree.from(leavesUpTo(3));
		expect(tree.leafHashAt(2)).toEqual(leafHash(leafFor(2)));
	});

	it('hands out copies, never live references into its own state', () => {
		const tree = MerkleTree.from(leavesUpTo(16));
		const reference = MerkleTree.from(leavesUpTo(16));

		// Two calls never alias each other or the memoized subtree nodes.
		expect(tree.root()).not.toBe(tree.root());
		expect(tree.leafHashAt(1)).not.toBe(tree.leafHashAt(1));
		expect(tree.inclusionProof(0, 16).at(-1)).not.toBe(tree.inclusionProof(1, 16).at(-1));
		expect(tree.consistencyProof(3, 16)[0]).not.toBe(tree.consistencyProof(3, 16)[0]);

		// And mutating anything handed out leaves the tree byte-identical.
		const mutations = [
			tree.root(),
			tree.root(9),
			tree.leafHashAt(1),
			...tree.inclusionProof(0, 16),
			...tree.consistencyProof(3, 16),
		];
		for (const buffer of mutations) buffer[0] = (buffer[0]! ^ 0xff) & 0xff;

		for (let size = 0; size <= 16; size++) {
			expect(tree.root(size)).toEqual(reference.root(size));
		}
		expect(tree.leafHashAt(1)).toEqual(reference.leafHashAt(1));
		expect(tree.inclusionProof(0, 16)).toEqual(reference.inclusionProof(0, 16));
		expect(tree.consistencyProof(3, 16)).toEqual(reference.consistencyProof(3, 16));
	});

	it('accepts arbitrary leaf lengths, including empty', () => {
		const tree = MerkleTree.from([Buffer.alloc(0), Buffer.alloc(4096, 0xab)]);
		expect(tree.size).toBe(2);
		expect(tree.root()).toHaveLength(32);
	});

	it('rejects out-of-range indices and sizes', () => {
		const tree = MerkleTree.from(leavesUpTo(4));
		expect(() => tree.leafHashAt(4)).toThrow(RangeError);
		expect(() => tree.leafHashAt(-1)).toThrow(RangeError);
		expect(() => tree.leafHashAt(1.5)).toThrow(RangeError);
		expect(() => tree.root(5)).toThrow(RangeError);
		expect(() => tree.root(-1)).toThrow(RangeError);
		expect(() => tree.inclusionProof(0, 0)).toThrow(RangeError);
		expect(() => tree.inclusionProof(3, 3)).toThrow(RangeError);
		expect(() => tree.inclusionProof(0, 9)).toThrow(RangeError);
		expect(() => tree.consistencyProof(5, 4)).toThrow(RangeError);
		expect(() => tree.consistencyProof(1, 9)).toThrow(RangeError);
		expect(() => new MerkleTree().inclusionProof(0)).toThrow(RangeError);
	});

	it('produces empty consistency proofs at the trivial boundaries', () => {
		const tree = MerkleTree.from(leavesUpTo(6));
		expect(tree.consistencyProof(0, 6)).toEqual([]);
		expect(tree.consistencyProof(6, 6)).toEqual([]);
		expect(new MerkleTree().consistencyProof(0, 0)).toEqual([]);
	});

	it('matches the uncached reference MTH while the tree grows', () => {
		const growing = new MerkleTree();
		const leaves: Buffer[] = [];
		for (let i = 0; i < 70; i++) {
			growing.append(leafFor(i));
			leaves.push(leafFor(i));
			expect(growing.root()).toEqual(naiveRoot(leaves));
		}
		// Every historic root is still reproducible from the same tree.
		for (let size = 0; size <= 70; size++) {
			expect(growing.root(size)).toEqual(naiveRoot(leaves.slice(0, size)));
		}
	});

	it('proves membership and growth at a size past the memoization boundaries', () => {
		const size = 1000;
		const tree = MerkleTree.from(leavesUpTo(size));
		expect(tree.root()).toEqual(naiveRoot(leavesUpTo(size)));
		for (const index of [0, 1, 511, 512, 733, 998, 999]) {
			expect(
				verifyInclusion({
					leaf: leafFor(index),
					index,
					treeSize: size,
					proof: tree.inclusionProof(index, size),
					root: tree.root(size),
				})
			).toBe(true);
		}
		for (const oldSize of [1, 2, 512, 513, 999]) {
			expect(
				verifyConsistency({
					oldSize,
					newSize: size,
					oldRoot: tree.root(oldSize),
					newRoot: tree.root(size),
					proof: tree.consistencyProof(oldSize, size),
				})
			).toBe(true);
		}
	});

	it('defaults treeSize arguments to the current size', () => {
		const tree = MerkleTree.from(leavesUpTo(7));
		expect(tree.root()).toEqual(tree.root(7));
		expect(tree.inclusionProof(2)).toEqual(tree.inclusionProof(2, 7));
		expect(tree.consistencyProof(3)).toEqual(tree.consistencyProof(3, 7));
	});
});
