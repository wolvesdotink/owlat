/**
 * RFC 6962 §2.1 / RFC 9162 §2.1.1 Merkle hashing.
 *
 * Leaves are hashed with a 0x00 prefix and interior nodes with 0x01. That
 * domain separation is the whole security argument of the structure: without
 * it an interior node could be replayed as a leaf, and a proof for one tree
 * shape would verify against another. Every hash produced or consumed here is
 * exactly `HASH_LENGTH` bytes; the tree, the proof verifiers and the batch
 * commitments build on these three functions and nothing else.
 */

import { sha256 } from '../crypto.js';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/** Digest size (bytes) of every node hash in the tree. */
export const HASH_LENGTH = 32;

/**
 * MTH({}) — the root of the empty tree, SHA-256 of the empty string.
 * A fresh log has a well-defined, signable head; `verifyConsistency` relies on
 * this being the only acceptable root for `oldSize === 0`.
 */
export function emptyTreeRoot(): Buffer {
	return sha256(Buffer.alloc(0));
}

/** MTH({d}) = SHA-256(0x00 || d). Accepts arbitrary-length leaf data. */
export function leafHash(data: Uint8Array): Buffer {
	return sha256(Buffer.concat([LEAF_PREFIX, data]));
}

/**
 * Interior node: SHA-256(0x01 || left || right).
 *
 * @throws RangeError if either child is not a `HASH_LENGTH`-byte digest —
 * callers that accept untrusted proofs must length-check first and fail the
 * proof rather than let this throw.
 */
export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
	if (left.length !== HASH_LENGTH || right.length !== HASH_LENGTH) {
		throw new RangeError(`merkle node children must be ${HASH_LENGTH}-byte hashes`);
	}
	return sha256(Buffer.concat([NODE_PREFIX, left, right]));
}

/** True when both buffers are `HASH_LENGTH` bytes and byte-identical. */
export function hashEquals(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === HASH_LENGTH && b.length === HASH_LENGTH && Buffer.compare(a, b) === 0;
}

/** True when every element is a `HASH_LENGTH`-byte digest. */
export function isHashList(values: readonly Uint8Array[]): boolean {
	return values.every((value) => value.length === HASH_LENGTH);
}

/**
 * Largest power of two strictly smaller than `n` (RFC 6962's `k`).
 * Defined for `n >= 2`; the tree splits `D[n]` at this index.
 */
export function splitPoint(n: number): number {
	let k = 1;
	while (k * 2 < n) k *= 2;
	return k;
}

/**
 * True when `n` is a positive exact power of two. Arithmetic rather than
 * bitwise so it stays correct for tree sizes above 2^31.
 */
export function isPowerOfTwo(n: number): boolean {
	if (!Number.isSafeInteger(n) || n < 1) return false;
	let rest = n;
	while (rest % 2 === 0) rest /= 2;
	return rest === 1;
}
