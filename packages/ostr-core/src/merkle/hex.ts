/**
 * The hex/bytes seam between published documents and the proof machinery.
 *
 * `SpamReportBatchBody.commitment` and `SignedTreeHead.rootHash` travel as
 * lowercase hex, while every function here takes and returns raw digests.
 * `Buffer.from(value, 'hex')` truncates at the first non-hex character instead
 * of failing, so a typo'd commitment would silently become a short buffer and
 * fail as "wrong root" rather than "malformed input"; parsing goes through a
 * checked helper.
 */

import { isSha256Hex } from '../attestation/fields.js';
import { HASH_LENGTH } from './hash.js';

/**
 * Parse a lowercase hex sha256 digest as published in an attestation or an
 * STH. `undefined` for anything else, including uppercase — a digest signed in
 * one spelling is not the same document in another.
 */
export function parseHash(value: unknown): Buffer | undefined {
	if (!isSha256Hex(value)) return undefined;
	return Buffer.from(value, 'hex');
}

/**
 * Lowercase hex of a digest, the form documents publish.
 *
 * @throws RangeError if `hash` is not `HASH_LENGTH` bytes — a short digest in a
 * published commitment is a bug at the producer, not something a verifier
 * should have to tolerate.
 */
export function toHex(hash: Uint8Array): string {
	if (hash.length !== HASH_LENGTH) {
		throw new RangeError(`hash must be ${HASH_LENGTH} bytes to publish as hex`);
	}
	return Buffer.from(hash).toString('hex');
}
