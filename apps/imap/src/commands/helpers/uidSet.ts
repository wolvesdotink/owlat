/**
 * UID set → message id resolution. Shared by STORE, COPY, MOVE,
 * FETCH-with-body, EXPUNGE. The raw `parseUidSet` parser lives in
 * `parser.ts`; this wrapper turns ranges into Convex `mailMessages`
 * ids via `mail/imap/fetch:resolveMessageIdsByUid`, paged (a `1:*` range is
 * the whole folder, which no single Convex execution may read).
 */

import type { ConvexClient } from '../../convex.js';
import { loadMessageIds } from './folderPaging.js';

export async function collectMessageIds(
	convex: ConvexClient,
	folderId: string,
	ranges: ReadonlyArray<readonly [number, number]>
): Promise<string[]> {
	const ids: string[] = [];
	for (const [low, high] of ranges) {
		const slice = await loadMessageIds(convex, folderId, low, high);
		for (const row of slice) ids.push(row._id);
	}
	return ids;
}

/**
 * Resolve a single contiguous UID span to a `uid → mailMessages id` map via
 * one paged `resolveMessageIdsByUid` walk of that span. Callers that hold an
 * exact set of resolved UIDs (e.g. STORE, after the seq↔UID map has
 * interpreted the request) pick the ids they need out of the map, so a
 * contiguous set such as `STORE 1:1000` costs a walk of that span rather than
 * one query per message — mirroring the FETCH path's envelope read.
 */
export async function collectMessageIdsByUid(
	convex: ConvexClient,
	folderId: string,
	uidLow: number,
	uidHigh: number
): Promise<Map<number, string>> {
	const slice = await loadMessageIds(convex, folderId, uidLow, uidHigh);
	const byUid = new Map<number, string>();
	for (const row of slice) byUid.set(row.uid, row._id);
	return byUid;
}
