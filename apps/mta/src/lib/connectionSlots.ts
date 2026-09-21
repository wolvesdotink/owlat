/**
 * Per-IP connection-slot bookkeeping shared by the MX/bounce and submission
 * listeners.
 *
 * The per-IP connection limiter (`checkConnectionRateLimit` in
 * `inboundSecurity.ts` / `submissionSecurity.ts`) increments a Redis counter for
 * every admitted connection and nets it back to zero for a rejected one, so only
 * the ADMITTED connections still hold a slot that must be released on close. This
 * tracker reconciles those held increments against socket lifetime so every kept
 * increment is released EXACTLY once. `checkConnectionRateLimit` is async, so a
 * connection can close (client RST — port scans, LB health probes do exactly
 * this) while its rate-limit round-trip is still in flight; two per-connection
 * registries handle the two possible orderings of the async check vs. the socket
 * `close` event:
 *
 *   - `live` — added on TCP accept, deleted on close. "Live" iff close hasn't run.
 *   - `held` — the connection took a slot (net +1) and still needs releasing.
 *
 * {@link SlotTracker.hold} marks `held` only if the connection is still live; if it
 * already closed, the close handler could not have released it (the key was never
 * in `held`), so it releases immediately. The close handler releases iff the slot
 * was marked. Either ordering nets exactly one release.
 *
 * The two listeners key their Redis counters under different prefixes
 * (`inboundSecurity.releaseConnection` vs `submissionSecurity.releaseConnection`),
 * so the concrete release function is injected — the reconciliation logic is the
 * only thing shared.
 *
 * The counter's own two operations — take a slot, give it back — live here too,
 * as the Lua both listeners run against their own key.
 */

import type { Socket } from 'node:net';
import type Redis from 'ioredis';

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
 * this pair exists to avoid — and {@link createSlotTracker} deliberately
 * swallows release failures, so nothing would have reported it.
 */
const RELEASE_SLOT_SCRIPT = `
if redis.call('DECR', KEYS[1]) <= 0 then redis.call('DEL', KEYS[1]) end
return 1
`;

/** Strip the IPv4-mapped IPv6 prefix so a host is keyed consistently. */
export function normalizeSlotIp(ip: string): string {
	return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/**
 * Admit or refuse one connection from `remoteIp`.
 *
 * Throws on a Redis fault, leaving nothing behind — callers fail open and
 * accept the connection WITHOUT registering a release, so a surviving
 * increment would leak a slot for the whole window.
 */
export async function acquireConnectionSlot(
	redis: Redis,
	key: string,
	maxConnectionsPerIp: number,
	ttlSeconds: number
): Promise<boolean> {
	return (
		Number(await redis.eval(ACQUIRE_SLOT_SCRIPT, 1, key, ttlSeconds, maxConnectionsPerIp)) === 1
	);
}

/** Release one connection slot for `remoteIp`. */
export async function releaseConnectionSlot(redis: Redis, key: string): Promise<void> {
	await redis.eval(RELEASE_SLOT_SCRIPT, 1, key);
}

/** The minimal peer shape {@link SlotTracker.hold} reads (peer identity). */
export interface SlotPeer {
	remoteAddress: string;
	remotePort: number;
}

/** Releases one slot for `remoteIp` on the listener's own Redis counter. */
export type ReleaseSlot = (redis: Redis, remoteIp: string) => Promise<void>;

/** Reconciles the per-IP connection counter's increments against socket lifetime. */
export interface SlotTracker {
	/** Raw-accept side: register the connection and release its slot on close. */
	track(socket: Socket): void;
	/** Slot-kept side: mark for release, or release now if the peer already left. */
	hold(peer: SlotPeer): void;
}

/**
 * Per-connection key (unique while live). Both the mark side (the session, whose
 * `remoteAddress` falls back to `''`) and the release side (the raw socket, whose
 * `remoteAddress` is `string | undefined`) derive the key through this one helper
 * so they always agree for the same TCP peer.
 */
function connectionKey(remoteAddress: string | undefined, remotePort: number | undefined): string {
	return `${remoteAddress || 'unknown'}:${remotePort ?? 0}`;
}

export function createSlotTracker(redis: Redis, release: ReleaseSlot): SlotTracker {
	const live = new Set<string>();
	const held = new Set<string>();
	return {
		track(socket: Socket): void {
			const remoteIp = socket.remoteAddress ?? 'unknown';
			const key = connectionKey(socket.remoteAddress, socket.remotePort);
			live.add(key);
			socket.once('close', () => {
				live.delete(key);
				if (!held.delete(key)) return; // this connection never took a slot
				release(redis, remoteIp).catch(() => {
					// Non-critical: the Redis counter carries a TTL as a backstop.
				});
			});
		},
		hold(peer: SlotPeer): void {
			const key = connectionKey(peer.remoteAddress, peer.remotePort);
			if (live.has(key)) {
				held.add(key); // release on close
				return;
			}
			// Closed during the in-flight rate-limit check: the increment happened but
			// no close handler will release it (the key was never in `held`). Release now.
			release(redis, peer.remoteAddress || 'unknown').catch(() => {
				// Non-critical: the Redis counter carries a TTL as a backstop.
			});
		},
	};
}
