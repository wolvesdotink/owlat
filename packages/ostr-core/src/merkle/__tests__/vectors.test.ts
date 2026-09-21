/**
 * RFC 6962 / RFC 9162 known-answer vectors.
 *
 * The eight leaves are the CT reference test inputs (d(0) = "", d(1) = 0x00,
 * …), and the roots and paths below are the published CT vectors. They pin the
 * wire format of this log: if any of them changes, previously issued proofs
 * stop verifying and the log has silently forked from every other RFC 6962
 * implementation.
 */

import { describe, expect, it } from 'vitest';
import { emptyTreeRoot, leafHash, nodeHash } from '../hash.js';
import { verifyConsistency, verifyInclusion } from '../proof.js';
import { MerkleTree } from '../tree.js';

const LEAVES = [
	'',
	'00',
	'10',
	'2021',
	'3031',
	'40414243',
	'5051525354555657',
	'606162636465666768696a6b6c6d6e6f',
].map((hex) => Buffer.from(hex, 'hex'));

/** MTH(D[n]) for n = 0..8 (RFC 6962 reference values). */
const ROOTS = [
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
	'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
	'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
	'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
	'4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
	'76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
	'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
	'5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

const tree = MerkleTree.from(LEAVES);
const hex = (buffers: readonly Buffer[]): string[] => buffers.map((b) => b.toString('hex'));

describe('RFC 6962 hashing', () => {
	it('hashes the empty tree to sha256 of the empty string', () => {
		expect(emptyTreeRoot().toString('hex')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
	});

	it('prefixes leaves with 0x00', () => {
		// The published leaf hash of d(1) = 0x00.
		expect(leafHash(LEAVES[1]!).toString('hex')).toBe(
			'96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7'
		);
		expect(leafHash(LEAVES[0]!).toString('hex')).toBe(ROOTS[1]);
	});

	it('prefixes interior nodes with 0x01', () => {
		expect(nodeHash(leafHash(LEAVES[0]!), leafHash(LEAVES[1]!)).toString('hex')).toBe(ROOTS[2]);
	});

	it('rejects children that are not 32-byte hashes', () => {
		expect(() => nodeHash(Buffer.alloc(31), Buffer.alloc(32))).toThrow(RangeError);
		expect(() => nodeHash(Buffer.alloc(32), Buffer.alloc(33))).toThrow(RangeError);
	});
});

describe('MTH test vectors', () => {
	it.each(ROOTS.map((root, size) => ({ size, root })))(
		'MTH(D[$size]) = $root',
		({ size, root }) => {
			expect(tree.root(size).toString('hex')).toBe(root);
		}
	);
});

describe('inclusion path vectors', () => {
	const cases = [
		{ index: 0, treeSize: 1, path: [] as string[] },
		{
			index: 0,
			treeSize: 8,
			path: [
				'96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
				'5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
				'6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
			],
		},
		{
			index: 5,
			treeSize: 8,
			path: [
				'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
				'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
				'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
			],
		},
		{
			index: 2,
			treeSize: 3,
			path: ['fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125'],
		},
		{
			index: 1,
			treeSize: 5,
			path: [
				'6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
				'5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
				'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
			],
		},
	];

	it.each(cases)('PATH($index, D[$treeSize])', ({ index, treeSize, path }) => {
		const proof = tree.inclusionProof(index, treeSize);
		expect(hex(proof)).toEqual(path);
		expect(
			verifyInclusion({
				leaf: LEAVES[index]!,
				index,
				treeSize,
				proof,
				root: tree.root(treeSize),
			})
		).toBe(true);
	});
});

describe('consistency path vectors', () => {
	const cases = [
		{ oldSize: 1, newSize: 1, path: [] as string[] },
		{
			oldSize: 1,
			newSize: 8,
			path: [
				'96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7',
				'5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
				'6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4',
			],
		},
		{
			oldSize: 6,
			newSize: 8,
			path: [
				'0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a',
				'ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0',
				'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
			],
		},
		{
			oldSize: 2,
			newSize: 5,
			path: [
				'5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e',
				'bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b',
			],
		},
	];

	it.each(cases)('PROOF($oldSize, D[$newSize])', ({ oldSize, newSize, path }) => {
		const proof = tree.consistencyProof(oldSize, newSize);
		expect(hex(proof)).toEqual(path);
		expect(
			verifyConsistency({
				oldSize,
				newSize,
				oldRoot: tree.root(oldSize),
				newRoot: tree.root(newSize),
				proof,
			})
		).toBe(true);
	});
});
