/**
 * Per-recipient-domain outbound TLS mode overrides.
 *
 * The global posture is `OUTBOUND_TLS_MODE` (config). An operator can raise (or
 * lower) the TLS demand for a SPECIFIC recipient domain — e.g. require verified
 * TLS to a partner domain known to publish a valid certificate, without forcing
 * every receiver to that bar. Overrides live in a single Redis hash so they are
 * shared across MTA instances and survive restarts, and are managed through the
 * master-key-protected `/outbound-tls` route (mirrors DKIM key management).
 */

import type Redis from 'ioredis';
import { isOutboundTlsMode, type OutboundTlsMode } from './tlsPolicy.js';

/** Redis hash: field = recipient domain (lowercased), value = OutboundTlsMode. */
const OVERRIDES_KEY = 'mta:outbound-tls:overrides';

/** Set (or replace) the outbound TLS mode override for one recipient domain. */
export async function setOutboundTlsOverride(
	redis: Redis,
	domain: string,
	mode: OutboundTlsMode
): Promise<void> {
	await redis.hset(OVERRIDES_KEY, domain.toLowerCase(), mode);
}

/** Remove a domain's override (falls back to the global mode). Returns whether one existed. */
export async function removeOutboundTlsOverride(redis: Redis, domain: string): Promise<boolean> {
	const removed = await redis.hdel(OVERRIDES_KEY, domain.toLowerCase());
	return removed > 0;
}

/** List every configured override as a `domain → mode` map. */
export async function listOutboundTlsOverrides(
	redis: Redis
): Promise<Record<string, OutboundTlsMode>> {
	const raw = await redis.hgetall(OVERRIDES_KEY);
	const out: Record<string, OutboundTlsMode> = {};
	for (const [domain, value] of Object.entries(raw)) {
		if (isOutboundTlsMode(value)) out[domain] = value;
	}
	return out;
}

/**
 * Resolve the EFFECTIVE outbound TLS mode for a recipient domain: the per-domain
 * override when one is set (and valid), otherwise the global default. Never
 * throws — a Redis hiccup falls back to the global default so a lookup failure
 * cannot silently strengthen (bounce mail) or is otherwise the caller's floor.
 */
export async function resolveOutboundTlsMode(
	redis: Redis,
	domain: string,
	globalMode: OutboundTlsMode
): Promise<OutboundTlsMode> {
	try {
		const value = await redis.hget(OVERRIDES_KEY, domain.toLowerCase());
		if (value && isOutboundTlsMode(value)) return value;
	} catch {
		// Fall through to the global default on any lookup error.
	}
	return globalMode;
}
