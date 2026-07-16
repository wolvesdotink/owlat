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
	// Set TTL only on first increment (key creation)
	if (count === 1) {
		await redis.expire(key, CONNECTION_TTL);
	}

	if (count > maxConnectionsPerIp) {
		// Decrement back since we're rejecting
		await redis.decr(key);
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
