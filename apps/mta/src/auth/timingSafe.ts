/**
 * Constant-time string comparison for secrets (API keys, bearer tokens).
 *
 * A plain `a === b` short-circuits on the first differing byte, which leaks
 * timing information an attacker can use to recover the secret byte-by-byte.
 * This mirrors the Convex side (delivery/unsubscribe.ts, delivery/preferences.ts):
 * compare lengths first, then `timingSafeEqual` over equal-length buffers.
 */

import { timingSafeEqual } from 'crypto';

/**
 * Compare two strings in (effectively) constant time.
 *
 * Returns `false` for unequal-length inputs without invoking `timingSafeEqual`
 * (which throws on mismatched lengths). The length check itself is not
 * constant-time, but secret length is not the sensitive part — the bytes are.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, 'utf8');
	const bBuf = Buffer.from(b, 'utf8');
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}
