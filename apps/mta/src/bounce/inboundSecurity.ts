/**
 * Inbound SMTP Security
 *
 * Per-IP connection rate limiting and connection tracking for the
 * bounce/inbound SMTP server.
 *
 * SPF validation (RFC 7208) and DMARC evaluation (RFC 7489) moved into the
 * in-house `@owlat/mail-auth` package as part of the Own-the-Inbound migration
 * — `server.ts` imports `checkSpf` / `evaluateDmarc` from there. This module now
 * holds only rate limiting (no back-compat shim; see plan decision D3).
 */

import type Redis from 'ioredis';

const CONNECTION_PREFIX = 'mta:bounce:conn:';
const CONNECTION_TTL = 300; // 5 minute window for tracking

// ─── Per-IP Connection Rate Limiting ────────────────────────────────

/**
 * Check if a new connection from the given IP is allowed.
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
 * Release a connection slot when a client disconnects
 */
export async function releaseConnection(redis: Redis, remoteIp: string): Promise<void> {
	const key = `${CONNECTION_PREFIX}${normalizeIp(remoteIp)}`;
	const count = await redis.decr(key);
	// Cleanup if counter reaches 0 or goes negative
	if (count <= 0) {
		await redis.del(key);
	}
}

/**
 * Get current connection count for an IP (for monitoring)
 */
export async function getConnectionCount(redis: Redis, remoteIp: string): Promise<number> {
	const key = `${CONNECTION_PREFIX}${normalizeIp(remoteIp)}`;
	const count = await redis.get(key);
	return count ? parseInt(count, 10) : 0;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Strip the IPv4-mapped IPv6 prefix so a host is keyed consistently. */
function normalizeIp(ip: string): string {
	if (ip.startsWith('::ffff:')) {
		return ip.slice(7);
	}
	return ip;
}
