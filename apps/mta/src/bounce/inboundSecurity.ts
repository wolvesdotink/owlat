/**
 * Inbound SMTP Security
 *
 * Per-IP connection rate limiting and connection tracking for the
 * bounce/inbound SMTP server.
 *
 * SPF validation (RFC 7208) and DMARC evaluation (RFC 7489) moved into the
 * in-house `@owlat/mail-auth` package as part of the Own-the-Inbound migration —
 * `server.ts` imports `checkSpf` / `evaluateDmarc` from there. This module now
 * holds only rate limiting (no back-compat shim).
 */

import type Redis from 'ioredis';
import {
	acquireConnectionSlot,
	normalizeSlotIp,
	releaseConnectionSlot,
} from '../lib/connectionSlots.js';

const CONNECTION_PREFIX = 'mta:bounce:conn:';
const CONNECTION_TTL = 300; // 5 minute window for tracking

// ─── Per-IP Connection Rate Limiting ────────────────────────────────

function connectionKey(remoteIp: string): string {
	return `${CONNECTION_PREFIX}${normalizeSlotIp(remoteIp)}`;
}

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
	return acquireConnectionSlot(redis, connectionKey(remoteIp), maxConnectionsPerIp, CONNECTION_TTL);
}

/**
 * Release a connection slot when a client disconnects
 */
export async function releaseConnection(redis: Redis, remoteIp: string): Promise<void> {
	await releaseConnectionSlot(redis, connectionKey(remoteIp));
}

/**
 * Get current connection count for an IP (for monitoring)
 */
export async function getConnectionCount(redis: Redis, remoteIp: string): Promise<number> {
	const count = await redis.get(connectionKey(remoteIp));
	return count ? parseInt(count, 10) : 0;
}
