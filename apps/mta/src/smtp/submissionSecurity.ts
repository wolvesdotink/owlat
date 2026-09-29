/**
 * Submission SMTP Security
 *
 * Per-IP failed-AUTH throttling for the submission listeners (587 and 465).
 * It defends the master-key and per-org-credential AUTH paths against
 * brute-force-by-reconnect (RFC 4954 §4: servers SHOULD limit authentication
 * failures; OWASP brute-force mitigation). The per-IP connection cap is the
 * listener's admission, over the counter in lib/connectionSlots.ts.
 *
 * The counter is keyed on `ipRateLimitKey`: the full address for IPv4, the /64
 * for IPv6, since one host can draw a fresh source address from its /64 for
 * every connection. A successful AUTH does not reset it, so a client holding
 * one valid credential gets no fresh budget for guessing the others; it simply
 * ages out with the rolling window. Postbox app passwords are additionally
 * throttled per address and per client IP by the Convex `verify` action.
 */

import type Redis from 'ioredis';
import { ipRateLimitKey } from '@owlat/shared/ipAddress';

const AUTH_FAIL_PREFIX = 'mta:submission:authfail:';
const AUTH_FAIL_TTL = 900; // 15-minute rolling window for failed AUTH attempts

// ─── Per-IP Failed-AUTH Throttling ──────────────────────────────────

const authFailKey = (remoteIp: string): string => `${AUTH_FAIL_PREFIX}${ipRateLimitKey(remoteIp)}`;

/**
 * Returns true when the IP has NOT exceeded its failed-AUTH budget within the
 * rolling window (i.e. AUTH is still allowed). Read-only — does not mutate the
 * counter; call {@link recordAuthFailure} after a failed attempt.
 */
export async function checkAuthThrottle(
	redis: Redis,
	remoteIp: string,
	maxFailuresPerIp: number
): Promise<boolean> {
	const raw = await redis.get(authFailKey(remoteIp));
	const failures = raw ? parseInt(raw, 10) : 0;
	return failures < maxFailuresPerIp;
}

/**
 * Count the failure and refresh the rolling window, in one round trip.
 *
 * The window has to move with every failure so a sustained attack stays locked
 * out — but split across two calls, an INCR that landed and an EXPIRE that
 * faulted left a counter with no expiry, and this counter is what BLOCKS AUTH:
 * an untimed one locks that IP out of submission permanently. The key is named
 * after an unauthenticated peer, so it is also one more untimed key on a Redis
 * running `maxmemory-policy noeviction`.
 *
 * KEYS: 1 = the per-IP failure counter. ARGV: 1 = window TTL (s).
 */
const RECORD_AUTH_FAILURE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return count
`;

/**
 * Record one failed AUTH attempt for the IP, refreshing the rolling window.
 * @returns the failure count after recording.
 */
export async function recordAuthFailure(redis: Redis, remoteIp: string): Promise<number> {
	return Number(
		await redis.eval(RECORD_AUTH_FAILURE_SCRIPT, 1, authFailKey(remoteIp), AUTH_FAIL_TTL)
	);
}
