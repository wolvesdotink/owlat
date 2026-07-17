/**
 * Per-IP connection-slot bookkeeping for the MX / bounce listener.
 *
 * `checkConnectionRateLimit` (inboundSecurity.ts) increments a Redis counter for
 * every admitted connection and nets it back to zero for a rejected one, so only
 * the ADMITTED connections still hold a slot that must be released on close. This
 * tracker reconciles those held increments against socket lifetime so every kept
 * increment is released EXACTLY once — the same bookkeeping the submission
 * listener uses. Two registries handle the two possible orderings of the async
 * rate-limit check vs. the socket `close` event:
 *
 *   - `live` — added on TCP accept, deleted on close. "Live" iff close hasn't run.
 *   - `held` — the connection took a slot (net +1) and still needs releasing.
 *
 * {@link SlotTracker.hold} marks `held` only if the connection is still live; if it
 * already closed, the close handler could not have released it (the key was never
 * in `held`), so it releases immediately. The close handler releases iff the slot
 * was marked. Either ordering nets exactly one release.
 */

import type { Socket } from 'node:net';
import type Redis from 'ioredis';
import { releaseConnection } from './inboundSecurity.js';

/** The minimal session shape {@link SlotTracker.hold} reads (peer identity). */
interface SlotPeer {
	remoteAddress: string;
	remotePort: number;
}

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

export function createSlotTracker(redis: Redis): SlotTracker {
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
				releaseConnection(redis, remoteIp).catch(() => {
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
			releaseConnection(redis, peer.remoteAddress || 'unknown').catch(() => {
				// Non-critical: the Redis counter carries a TTL as a backstop.
			});
		},
	};
}
