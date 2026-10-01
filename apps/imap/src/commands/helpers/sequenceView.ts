/**
 * Keeping the client's sequence view (`SequenceView` in `../types.ts`) in step
 * with the folder.
 *
 * RFC 3501 §7.4.1: the server may tell a client about other sessions' expunges
 * only while a command is in progress, and never during FETCH, STORE or SEARCH,
 * because that would renumber messages under a command that addresses them by
 * number. UID commands are allowed to. So:
 *
 *   - sequence-number FETCH / STORE / COPY / MOVE resolve against the view as
 *     it stands and announce nothing;
 *   - SELECT starts the view; NOOP, CHECK, IDLE, EXPUNGE and every UID command
 *     first announce what changed (`* n EXPUNGE` for each message gone, highest
 *     first, then `* n EXISTS` if any arrived) and adopt the folder as it is.
 */

import type { CommandDeps, ConnectionState, SequenceView } from '../types.js';
import { loadCurrentUids } from './membership.js';

/**
 * What changed between two ascending UID lists: the positions in `prev` of the
 * UIDs that are gone, highest first (each stays valid while the ones before it
 * are applied), and whether any UID arrived. A linear merge, so a sync of a
 * 100k-message folder costs no sets or sorts.
 */
export function membershipDelta(
	prev: readonly number[],
	next: readonly number[]
): { expunged: number[]; hasArrivals: boolean } {
	const expunged: number[] = [];
	let hasArrivals = false;
	let j = 0;
	for (let i = 0; i < prev.length; i += 1) {
		const uid = prev[i]!;
		while (j < next.length && next[j]! < uid) {
			hasArrivals = true;
			j += 1;
		}
		if (j < next.length && next[j] === uid) j += 1;
		else expunged.push(i + 1);
	}
	if (j < next.length) hasArrivals = true;
	return { expunged: expunged.reverse(), hasArrivals };
}

/**
 * Announce to the client every change since its view, adopt the folder's
 * current UIDs as the view, and return them. Without a view (a state built by
 * hand) it only returns the current UIDs.
 */
export async function syncSequenceView(
	deps: CommandDeps,
	state: ConnectionState,
	send: (line: string) => void,
	signal?: AbortSignal
): Promise<readonly number[]> {
	const selected = state.selected!;
	const current = await loadCurrentUids(deps.convex, selected.folderId, signal);
	const view = selected.view;
	if (!view || view.uids === current) return current;
	const { expunged, hasArrivals } = membershipDelta(view.uids, current);
	for (const seq of expunged) send(`* ${seq} EXPUNGE`);
	if (hasArrivals) send(`* ${current.length} EXISTS`);
	view.uids = current;
	return current;
}

/**
 * Take this session's own expunged (or moved-away) messages out of the view.
 * Returns their sequence numbers highest first, the order to announce them in;
 * a UID the client was never told about has no number and is skipped.
 */
export function expungeFromView(view: SequenceView, uids: readonly number[]): number[] {
	if (uids.length === 0) return [];
	const gone = new Set(uids);
	const seqs: number[] = [];
	const kept: number[] = [];
	for (let i = 0; i < view.uids.length; i += 1) {
		const uid = view.uids[i]!;
		if (gone.has(uid)) seqs.push(i + 1);
		else kept.push(uid);
	}
	view.uids = kept;
	return seqs.reverse();
}
