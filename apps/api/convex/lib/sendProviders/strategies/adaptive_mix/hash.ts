/**
 * The mix hash — the deterministic per-recipient bucket function (plan D7).
 *
 * Requirements, in the order they matter:
 *
 *   1. UNIFORM. The arm proportions must equal the configured share, so the
 *      bucket space has to be flat. FNV-1a alone is not: it leaves visible
 *      low-bit structure for short, highly-similar keys — exactly the keys we
 *      feed it (`<id>:<id>:<int>` where the ids differ in one character). The
 *      murmur3 finalizer (`fmix32`) is applied on top purely as an avalanche
 *      step, which is what makes `% MIX_BUCKET_SPACE` flat.
 *   2. STABLE. The same key must produce the same bucket forever and on every
 *      runtime — no `Math.random`, no clock, no locale, no `Map` iteration
 *      order. A recipient that moved arms between two pages of one campaign
 *      would corrupt every ratio the controller reads.
 *   3. NOT CALLER-STEERABLE. Bucket assignment must not be predictable from
 *      the SHAPE of an input a caller controls: sequential contact ids,
 *      timestamps or an incrementing campaign counter must not walk the bucket
 *      space monotonically, or a caller could pick an arm by picking an id.
 *      The avalanche step is what buys this — a one-bit change in the key
 *      changes ~half the output bits.
 *
 * This is NOT a cryptographic MAC and does not claim to be: a determined
 * attacker who can pick unlimited ids and observe the resulting arm can grind
 * for a bucket. The threat this function actually defends against is the
 * realistic one — a caller whose ids happen to be structured, and a caller who
 * would otherwise notice that "contacts created in the same second land in the
 * same arm". Keying it with a secret would make the buckets unreproducible
 * from the recorded assignment rows, which is a worse trade for a measurement
 * system whose whole job is to be auditable (D12).
 */

/**
 * Buckets are basis points: 10,000 slots gives the controller's 1pp steps a
 * whole 100 slots each, so `Math.round(share * MIX_BUCKET_SPACE)` never
 * quantises a legal share away.
 */
export const MIX_BUCKET_SPACE = 10_000;

/**
 * Namespace prefix. Two different hash CONSUMERS (arm bucket vs calibration
 * bucket) must not be able to agree, or the calibration slice would correlate
 * with the arm; and a future consumer must not silently reuse this one's
 * partition. Callers add their own consumer prefix on top of this.
 */
const MIX_HASH_NAMESPACE = 'owlat.deliverability.mix.v1|';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** murmur3 32-bit finalizer — the avalanche step. */
function fmix32(value: number): number {
	let h = value >>> 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return h >>> 0;
}

/**
 * Stable 32-bit hash of a key, as an unsigned integer.
 *
 * Iterates UTF-16 code units rather than bytes. That is a deliberate
 * simplification: the keys this function sees are Convex document ids, and
 * mixing code units keeps the function a pure, dependency-free one-liner
 * without a `TextEncoder` allocation per recipient. It changes nothing about
 * uniformity — every code unit still reaches the avalanche step.
 */
export function hash32(key: string): number {
	const input = `${MIX_HASH_NAMESPACE}${key}`;
	let h = FNV_OFFSET_BASIS;
	for (let index = 0; index < input.length; index += 1) {
		h ^= input.charCodeAt(index);
		h = Math.imul(h, FNV_PRIME);
	}
	return fmix32(h);
}

/** The key's slot in `[0, MIX_BUCKET_SPACE)`. */
export function bucketFor(key: string): number {
	return hash32(key) % MIX_BUCKET_SPACE;
}
