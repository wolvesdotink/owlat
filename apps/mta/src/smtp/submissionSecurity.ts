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
import {
	acquireConnectionSlot,
	normalizeSlotIp,
	releaseConnectionSlot,
} from '../lib/connectionSlots.js';

const CONNECTION_PREFIX = 'mta:submission:conn:';
const CONNECTION_TTL = 300; // 5-minute window for tracking concurrent connections

const AUTH_FAIL_PREFIX = 'mta:submission:authfail:';
const AUTH_FAIL_TTL = 900; // 15-minute rolling window for failed AUTH attempts

// ─── Per-IP Connection Rate Limiting ────────────────────────────────

function connectionKey(remoteIp: string): string {
	return `${CONNECTION_PREFIX}${normalizeSlotIp(remoteIp)}`;
}

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
	return acquireConnectionSlot(redis, connectionKey(remoteIp), maxConnectionsPerIp, CONNECTION_TTL);
}

/**
 * Release a connection slot when a client disconnects.
 */
export async function releaseConnection(redis: Redis, remoteIp: string): Promise<void> {
	await releaseConnectionSlot(redis, connectionKey(remoteIp));
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
	const key = `${AUTH_FAIL_PREFIX}${normalizeSlotIp(remoteIp)}`;
	const raw = await redis.get(key);
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
	const key = `${AUTH_FAIL_PREFIX}${normalizeSlotIp(remoteIp)}`;
	return Number(await redis.eval(RECORD_AUTH_FAILURE_SCRIPT, 1, key, AUTH_FAIL_TTL));
}

/**
 * Clear the failed-AUTH counter for an IP after a successful authentication.
 */
export async function clearAuthFailures(redis: Redis, remoteIp: string): Promise<void> {
	const key = `${AUTH_FAIL_PREFIX}${normalizeSlotIp(remoteIp)}`;
	await redis.del(key);
}
