/**
 * The per-IP connection limiter the MX/bounce and submission listeners hand to
 * `@owlat/smtp-listener` as `admission.perIp`.
 *
 * The listener owns the admission flow: it counts live connections for the
 * global cap, calls `acquire` before any hook runs, and calls `release` exactly
 * once for every granted slot when that connection closes (including one that
 * reset while its acquire was in flight). This module supplies only the
 * counter: one Redis key per peer, shared by every MTA replica, under a
 * listener-specific prefix (`mta:bounce:conn:` for port 25,
 * `mta:submission:conn:` for 587 and 465). A peer is keyed with
 * `ipRateLimitKey`: the address for IPv4, the /64 for IPv6, since one host can
 * take a fresh source address from its /64 for every connection.
 */

import type Redis from 'ioredis';
import { ipRateLimitKey } from '@owlat/shared/ipAddress';

/**
 * Take one slot on `key`, or refuse when the IP is already at its limit.
 *
 * ONE script, not INCR-then-EXPIRE, because the counter key is named after an
 * unauthenticated peer's IP and the Redis it lives in runs `--maxmemory` with
 * `maxmemory-policy noeviction` — at the cap Redis refuses writes and the MTA
 * stops accepting mail. Split across two round trips, an INCR that landed
 * followed by an EXPIRE that faulted left a counter with no expiry at all, and
 * the compensating DECR that undid the increment left it at zero rather than
 * removing it: a permanent key per IP that happened to be connecting during a
 * Redis blip. Inside one script there is no such in-between state, and the
 * reject path's decrement can no longer fault on its own either.
 *
 * The TTL is (re)applied only when the key has none, so a legacy untimed key
 * from the old two-call path is healed by the next connection from that IP,
 * while a busy IP still cannot keep a stuck over-count alive past its window —
 * that window is the only thing that reclaims a slot whose connection died
 * without a release.
 *
 * KEYS: 1 = the per-IP counter. ARGV: 1 = TTL (s), 2 = max connections.
 */
const ACQUIRE_SLOT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if count > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;

/**
 * Give the slot back, removing the counter once nobody holds one.
 *
 * Also one script: DECR on an already-expired key recreates it at -1 with no
 * expiry, so a DEL that faulted on the next line left exactly the untimed key
 * this pair exists to avoid — and the listener deliberately swallows release
 * failures, so nothing would have reported it.
 */
const RELEASE_SLOT_SCRIPT = `
if redis.call('DECR', KEYS[1]) <= 0 then redis.call('DEL', KEYS[1]) end
return 1
`;

/** The peer identity the limiter keys on. */
interface LimiterPeer {
	readonly remoteAddress: string;
}

/** A per-IP connection-slot limiter over one Redis key prefix. */
interface ConnectionLimiter {
	/**
	 * Take one slot for the peer's IP, or refuse (`false`) when the IP is at its
	 * limit. Throws on a Redis fault, leaving nothing behind: the listener fails
	 * open and owes no release, so a surviving increment would leak a slot for
	 * the whole window.
	 */
	acquire(peer: LimiterPeer): Promise<boolean>;
	/** Give back one slot taken by {@link ConnectionLimiter.acquire}. */
	release(peer: LimiterPeer): Promise<void>;
}

/**
 * Build the limiter for one listener. Keys are `${prefix}${ipRateLimitKey(ip)}`:
 * an IPv4-mapped IPv6 peer is unmapped, so a dual-stack socket and a v4 socket
 * from the same host share one counter, and an IPv6 peer counts under its /64
 * (`2001:db8:1:2::/64`). The key names and `ttlSeconds` are part of the
 * rolling-deploy contract: replicas that count the same keys share one limit.
 * IPv4 keys are unchanged from the per-address scheme. While replicas that
 * still key IPv6 per address run next to ones that key it per /64, an IPv6 peer
 * is counted under both kinds of key, so its limit is briefly looser; every
 * replica releases under the key it acquired, so no slot leaks.
 */
export function createConnectionLimiter(
	redis: Redis,
	prefix: string,
	ttlSeconds: number,
	maxPerIp: number
): ConnectionLimiter {
	const key = (peer: LimiterPeer): string =>
		`${prefix}${ipRateLimitKey(peer.remoteAddress || 'unknown')}`;
	return {
		async acquire(peer) {
			return (
				Number(await redis.eval(ACQUIRE_SLOT_SCRIPT, 1, key(peer), ttlSeconds, maxPerIp)) === 1
			);
		},
		async release(peer) {
			await redis.eval(RELEASE_SLOT_SCRIPT, 1, key(peer));
		},
	};
}
