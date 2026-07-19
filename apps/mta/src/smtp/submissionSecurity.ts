/**
 * Submission SMTP Security
 *
 * Per-IP connection tracking and failed-AUTH throttling for the submission
 * server (port 587). Mirrors the bounce server's connection limiter
 * (bounce/inboundSecurity.ts) but with submission-specific Redis prefixes so
 * the two listeners do not share counters.
 *
 * The auth-failure throttle defends the master-key and per-org-credential
 * AUTH paths against brute-force-by-reconnect (RFC 4954 §4 — servers SHOULD
 * limit authentication failures; OWASP brute-force mitigation).
 */

import type Redis from 'ioredis';

const CONNECTION_PREFIX = 'mta:submission:conn:';
const CONNECTION_TTL = 300; // 5-minute window for tracking concurrent connections

const AUTH_FAIL_PREFIX = 'mta:submission:authfail:';
const AUTH_FAIL_TTL = 900; // 15-minute rolling window for failed AUTH attempts

function normalizeIp(ip: string): string {
	// Strip IPv4-mapped IPv6 prefix so v4 and v4-mapped-v6 share a counter.
	if (ip.startsWith('::ffff:')) {
		return ip.slice(7);
	}
	return ip;
}

// ─── Per-IP Connection Rate Limiting ────────────────────────────────

/**
 * Check whether a new connection from the given IP is allowed.
 * Uses a Redis counter with TTL to track concurrent connections per IP.
 *
 * @returns true if the connection is allowed
 */
export async function checkConnectionRateLimit(
	redis: Redis,
	remoteIp: string,
	maxConnectionsPerIp: number
): Promise<boolean> {
	const key = `${CONNECTION_PREFIX}${normalizeIp(remoteIp)}`;

	const count = await redis.incr(key);
	// From here the increment has already landed. If setting the TTL throws, undo
	// the increment before propagating: the caller (onConnect) fails open on error
	// and accepts the connection WITHOUT registering a slot release, so a surviving
	// increment would leak a per-IP slot until CONNECTION_TTL. Either this returns
	// (the increment stands, to be released on close) or it throws with the
	// increment undone — never both. The reject-path decr lives OUTSIDE this try so
	// a fault there can never trigger a SECOND compensating decr (double-decrement).
	try {
		// Set TTL only on first increment (key creation)
		if (count === 1) {
			await redis.expire(key, CONNECTION_TTL);
		}
	} catch (err) {
		try {
			await redis.decr(key);
		} catch {
			// swallow — CONNECTION_TTL is the backstop
		}
		throw err;
	}

	if (count > maxConnectionsPerIp) {
		// Over the limit: undo our own increment and reject. Rejecting is the correct
		// verdict regardless, so a decr fault is swallowed (over-count self-heals via
		// the TTL) rather than propagated — propagating would fail the caller OPEN and
		// admit the very connection we are rejecting.
		try {
			await redis.decr(key);
		} catch {
			// swallow — the TTL reclaims the over-count
		}
		return false;
	}

	return true;
}

/**
 * Release a connection slot when a client disconnects.
 */
export async function releaseConnection(redis: Redis, remoteIp: string): Promise<void> {
	const key = `${CONNECTION_PREFIX}${normalizeIp(remoteIp)}`;
	const count = await redis.decr(key);
	// Cleanup if counter reaches 0 or goes negative
	if (count <= 0) {
		await redis.del(key);
	}
}

// ─── Per-IP Failed-AUTH Throttling ──────────────────────────────────

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
	const key = `${AUTH_FAIL_PREFIX}${normalizeIp(remoteIp)}`;
	const raw = await redis.get(key);
	const failures = raw ? parseInt(raw, 10) : 0;
	return failures < maxFailuresPerIp;
}

/**
 * Record one failed AUTH attempt for the IP, refreshing the rolling window.
 * @returns the failure count after recording.
 */
export async function recordAuthFailure(redis: Redis, remoteIp: string): Promise<number> {
	const key = `${AUTH_FAIL_PREFIX}${normalizeIp(remoteIp)}`;
	const count = await redis.incr(key);
	// Refresh the window on every failure so a sustained attack stays locked out.
	await redis.expire(key, AUTH_FAIL_TTL);
	return count;
}

/**
 * Clear the failed-AUTH counter for an IP after a successful authentication.
 */
export async function clearAuthFailures(redis: Redis, remoteIp: string): Promise<void> {
	const key = `${AUTH_FAIL_PREFIX}${normalizeIp(remoteIp)}`;
	await redis.del(key);
}
