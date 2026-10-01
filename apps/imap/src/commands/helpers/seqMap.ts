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
import type { CommandDeps, ConnectionState } from '../types.js';
import { loadFolderUids, type UidRange } from './folderPaging.js';

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

/** 1-based sequence number for a UID, or undefined when the UID is absent. */
export function seqForUid(map: SeqMap, uid: number): number | undefined {
	// Binary search: `uids` is ascending, and MOVE / STORE look up one UID per
	// affected message.
	let lo = 0;
	let hi = map.uids.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const at = map.uids[mid] ?? 0;
		if (at === uid) return mid + 1;
		if (at < uid) lo = mid + 1;
		else hi = mid - 1;
	}
	return undefined;
}

export interface ResolvedMessage {
	readonly uid: number;
	readonly seq: number;
}

/**
 * Clamp each range to `[floor, ceiling]`, drop the ones left empty, then sort
 * and merge overlapping or adjacent ranges. The result is ascending and
 * disjoint, so walking it visits each member once no matter how many
 * duplicate or overlapping parts the request repeated.
 */
function coalesceRanges(
	ranges: ReadonlyArray<readonly [number, number]>,
	floor: number,
	ceiling: number
): Array<[number, number]> {
	const clamped: Array<[number, number]> = [];
	for (const [low, high] of ranges) {
		const lo = Math.max(low, floor);
		const hi = Math.min(high, ceiling);
		if (lo <= hi) clamped.push([lo, hi]);
	}
	clamped.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const range of clamped) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1] + 1) {
			if (range[1] > last[1]) last[1] = range[1];
		} else {
			merged.push(range);
		}
	}
	return merged;
}

/** Index of the first UID in `uids` (ascending) that is `>= target`. */
function lowerBound(uids: readonly number[], target: number): number {
	let lo = 0;
	let hi = uids.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if ((uids[mid] ?? 0) < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Resolve a message set to the `{ uid, seq }` rows it addresses, in
 * ascending sequence order, each message at most once.
 *
 * `byUid: false` — the set holds sequence numbers; each position maps to
 * its UID via the seq map, and `*` is the highest sequence number.
 * `byUid: true` — the set holds UIDs; `*` is the highest UID, and matches
 * are every UID in the requested ranges that actually exists in the
 * folder (so the emitted sequence number is the true position).
 *
 * Out-of-range positions / absent UIDs are silently dropped, matching how
 * real servers ignore set members that no longer exist (RFC 3501 §6.4.8).
 *
 * The ranges are clamped to the folder and coalesced before the walk, so
 * the cost is O(n + r log r) for n messages and r set parts: the numbers
 * in the request and repeated or overlapping parts cannot multiply it.
 */
export function resolveSet(map: SeqMap, spec: string, byUid: boolean): ResolvedMessage[] {
	const { uids } = map;
	if (uids.length === 0) return [];
	const out: ResolvedMessage[] = [];

	if (byUid) {
		const ranges = coalesceRanges(parseUidSet(spec, maxUid(map)), uids[0] ?? 0, maxUid(map));
		// Ranges are ascending and disjoint, so each binary search starts a
		// walk that never revisits a UID an earlier range already emitted.
		for (const [low, high] of ranges) {
			for (let i = lowerBound(uids, low); i < uids.length; i += 1) {
				const uid = uids[i] ?? 0;
				if (uid > high) break;
				out.push({ uid, seq: i + 1 });
			}
		}
		return out;
	}

	// Positions above the message count never resolve, so the ceiling clamp
	// also keeps `FETCH 1:2000000000` from spinning a two-billion-step loop.
	const ranges = coalesceRanges(parseUidSet(spec, maxSeq(map)), 1, maxSeq(map));
	for (const [low, high] of ranges) {
		for (let seq = low; seq <= high; seq += 1) {
			out.push({ uid: uids[seq - 1] ?? 0, seq });
		}
	}
	return out;
}

/**
 * The UID ranges that hold exactly the `resolved` messages: one range per run
 * of consecutive sequence numbers. Consecutive positions have no other message
 * between them in the map, so `[first uid, last uid]` of a run contains only
 * requested messages — `UID FETCH 1,100000` becomes two one-UID ranges, and
 * `1:*` stays the one whole-folder window. A message that arrives later gets a
 * UID above every existing one (`uidNext`), so it cannot land inside a range.
 *
 * `resolved` must be in ascending sequence order, as {@link resolveSet}
 * returns it; the ranges are then ascending and disjoint.
 */
export function uidRuns(resolved: readonly ResolvedMessage[]): UidRange[] {
	const runs: UidRange[] = [];
	let low = 0;
	let prev: ResolvedMessage | undefined;
	for (const message of resolved) {
		if (prev === undefined || message.seq !== prev.seq + 1) {
			if (prev !== undefined) runs.push({ low, high: prev.uid });
			low = message.uid;
		}
		prev = message;
	}
	if (prev !== undefined) runs.push({ low, high: prev.uid });
	return runs;
}

/**
 * Resolve a message set against the SELECTed folder: load its UIDs, build the
 * seq map and run {@link resolveSet}. Every command that takes a message set
 * (FETCH, STORE, COPY, MOVE, UID EXPUNGE) goes through here, so a set can only
 * ever address messages that exist in the folder, and resolving it costs time
 * linear in the folder size plus the number of set parts (see
 * {@link resolveSet}). `signal` stops the UID paging once the connection
 * has gone.
 */
export async function resolveSelectedSet(
	deps: CommandDeps,
	state: ConnectionState,
	set: string,
	byUid: boolean,
	signal?: AbortSignal
): Promise<{ seqMap: SeqMap; resolved: ResolvedMessage[] }> {
	const folderUids = await loadFolderUids(deps.convex, state.selected!.folderId, signal);
	const seqMap = buildSeqMap(folderUids);
	return { seqMap, resolved: resolveSet(seqMap, set, byUid) };
}
