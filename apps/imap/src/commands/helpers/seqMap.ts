/**
 * Sequence-number ↔ UID resolution for the SELECTed mailbox.
 *
 * IMAP distinguishes two ways to address messages (RFC 3501 §2.3.1):
 *   - **Message sequence numbers** (`FETCH 2:4`) — the 1-based position of
 *     a message in the mailbox, ordered by UID ascending. The relative
 *     position of the last message is `*`.
 *   - **Unique identifiers** (`UID FETCH 2:4`) — the per-message UID; here
 *     `*` is the largest UID in the mailbox.
 *
 * A non-UID `FETCH`/`STORE` set is therefore a set of *positions*, not
 * UIDs, and the per-row `* N FETCH` reply must carry the *true* sequence
 * number (the position), not a fabricated 1..N counter over the rows that
 * happened to match. This module builds the position↔UID map once from the
 * folder's ordered UID list and resolves both kinds of set against it.
 *
 * The map is the source of truth ordered list of UIDs ascending; index 0
 * is sequence number 1. RFC 3501 §2.3.1.2 / §6.4.5 / §6.4.8.
 */

import { parseUidSet } from '../../parser.js';

export interface SeqMap {
	/** UIDs in ascending order; position i (0-based) is sequence number i+1. */
	readonly uids: readonly number[];
}

/** Build a seq↔UID map from a folder's UID list (any order; sorted here). */
export function buildSeqMap(uids: ReadonlyArray<number>): SeqMap {
	return { uids: [...uids].sort((a, b) => a - b) };
}

/** The largest sequence number (== message count). */
export function maxSeq(map: SeqMap): number {
	return map.uids.length;
}

/** The largest UID, or 0 when the mailbox is empty. */
export function maxUid(map: SeqMap): number {
	return map.uids.length === 0 ? 0 : (map.uids[map.uids.length - 1] ?? 0);
}

/** UID for a 1-based sequence number, or undefined when out of range. */
export function uidForSeq(map: SeqMap, seq: number): number | undefined {
	if (seq < 1 || seq > map.uids.length) return undefined;
	return map.uids[seq - 1];
}

/** 1-based sequence number for a UID, or undefined when the UID is absent. */
export function seqForUid(map: SeqMap, uid: number): number | undefined {
	const idx = map.uids.indexOf(uid);
	return idx === -1 ? undefined : idx + 1;
}

export interface ResolvedMessage {
	readonly uid: number;
	readonly seq: number;
}

/**
 * Resolve a message set to the `{ uid, seq }` rows it addresses, in
 * ascending sequence order.
 *
 * `byUid: false` — the set holds sequence numbers; each position maps to
 * its UID via the seq map, and `*` is the highest sequence number.
 * `byUid: true` — the set holds UIDs; `*` is the highest UID, and matches
 * are every UID in the requested ranges that actually exists in the
 * folder (so the emitted sequence number is the true position).
 *
 * Out-of-range positions / absent UIDs are silently dropped, matching how
 * real servers ignore set members that no longer exist (RFC 3501 §6.4.8).
 */
export function resolveSet(
	map: SeqMap,
	spec: string,
	byUid: boolean,
): ResolvedMessage[] {
	if (map.uids.length === 0) return [];
	const ranges = parseUidSet(spec, byUid ? maxUid(map) : maxSeq(map));
	const seen = new Set<number>();
	const out: ResolvedMessage[] = [];

	if (byUid) {
		for (let seq = 1; seq <= map.uids.length; seq += 1) {
			const uid = map.uids[seq - 1] ?? 0;
			if (ranges.some(([low, high]) => uid >= low && uid <= high)) {
				if (!seen.has(seq)) {
					seen.add(seq);
					out.push({ uid, seq });
				}
			}
		}
		return out;
	}

	for (const [low, high] of ranges) {
		// Clamp the upper bound to the mailbox size: positions above the
		// message count can never resolve (`uidForSeq` returns undefined), so
		// iterating past it only burns CPU. Without this clamp a short,
		// syntactically-valid command like `FETCH 1:2000000000` would spin a
		// ~2-billion-iteration in-process loop and block the worker event loop.
		const hi = Math.min(high, map.uids.length);
		for (let seq = low; seq <= hi; seq += 1) {
			const uid = uidForSeq(map, seq);
			if (uid === undefined) continue;
			if (seen.has(seq)) continue;
			seen.add(seq);
			out.push({ uid, seq });
		}
	}
	out.sort((a, b) => a.seq - b.seq);
	return out;
}
