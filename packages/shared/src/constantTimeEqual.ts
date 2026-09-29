/**
 * Constant-time equality for the Node services (MTA, mail-sync, updater, the
 * web app's server routes) and the Node-only modules of this package.
 *
 * NODE-ONLY: uses `node:crypto`. Exposed via the `@owlat/shared/constantTimeEqual`
 * subpath only and never re-exported from the `.` barrel, which has to stay
 * browser-safe. The Convex backend has its own copy for the V8 isolate, in
 * `apps/api/convex/lib/crypto.ts`, with the same contract.
 *
 * Both inputs are hashed to SHA-256 before `timingSafeEqual` runs, so the two
 * buffers it sees always have the same length. Nothing branches on the input
 * lengths: an unequal length costs the same as an unequal byte, and the time
 * taken says nothing about the expected value's length or content.
 *
 * `scripts/check-crypto-primitives.sh` keeps `timingSafeEqual(` out of every
 * other module, so a new comparison has to come through here.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

type Comparable = string | Uint8Array;

function digest(value: Comparable): Buffer {
	return createHash('sha256').update(value).digest();
}

/**
 * Whether `a` and `b` hold the same bytes (strings compare as UTF-8). Two empty
 * values are equal; use {@link secretMatches} to authenticate a caller.
 */
export function constantTimeEqual(a: Comparable, b: Comparable): boolean {
	return timingSafeEqual(digest(a), digest(b));
}

/**
 * Whether a presented credential matches the configured one.
 *
 * Fails closed: an empty or missing value on EITHER side is a mismatch, so an
 * unset secret can never be satisfied by an empty header.
 */
export function secretMatches(
	presented: string | null | undefined,
	expected: string | null | undefined
): boolean {
	if (!presented || !expected) return false;
	return constantTimeEqual(presented, expected);
}
