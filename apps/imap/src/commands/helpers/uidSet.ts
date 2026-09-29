/**
 * Resolved UIDs → message id resolution. Shared by STORE, COPY and MOVE.
 * Callers first resolve the client's message set against the folder's
 * seq ↔ UID map (`seqMap.ts#resolveSelectedSet`); this helper turns the exact
 * UIDs that came out of it into Convex `mailMessages` ids via
 * `mail/imap/fetch:resolveMessageIdsByUid`, paged (a `1:*` set spans the whole
 * folder, which no single Convex execution may read).
 */

import type { ConvexClient } from '../../convex.js';
import { loadMessageIds } from './folderPaging.js';

/**
 * Message ids for `uids`, in the order given. One paged walk of the
 * min..max UID span serves the whole set, so a contiguous set such as
 * `STORE 1:1000` costs a walk of that span rather than one query per
 * message, mirroring the FETCH path's envelope read. Only the requested
 * UIDs are picked out of the span; UIDs that vanished in between (a
 * concurrent EXPUNGE) are dropped.
 */
export async function collectMessageIds(
	convex: ConvexClient,
	folderId: string,
	uids: ReadonlyArray<number>
): Promise<string[]> {
	if (uids.length === 0) return [];
	// A loop, not `Math.min(...uids)`: spreading a whole-folder set can exceed
	// the engine's argument limit.
	let low = Infinity;
	let high = -Infinity;
	for (const uid of uids) {
		if (uid < low) low = uid;
		if (uid > high) high = uid;
	}
	const slice = await loadMessageIds(convex, folderId, low, high);
	const byUid = new Map<number, string>();
	for (const row of slice) byUid.set(row.uid, row._id);
	const ids: string[] = [];
	for (const uid of uids) {
		const id = byUid.get(uid);
		if (id !== undefined) ids.push(id);
	}
	return ids;
}

/**
 * Most message ids or UIDs a command sends in one Convex call. Convex rejects
 * an array argument longer than 8,192 elements, so a set over a large folder
 * (`1:*`) goes out in several calls; the smaller batch also keeps each write
 * transaction well inside Convex's per-transaction read and write limits.
 */
export const CONVEX_BATCH_SIZE = 1000;

/** `items` split into consecutive batches of at most `size`, order kept. */
export function inBatches<T>(items: readonly T[], size: number = CONVEX_BATCH_SIZE): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
	return batches;
}
