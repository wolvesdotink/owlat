/**
 * UID set → message id resolution. Shared by STORE, COPY, MOVE,
 * FETCH-with-body, EXPUNGE. The raw `parseUidSet` parser lives in
 * `parser.ts`; this wrapper turns ranges into Convex `mailMessages`
 * ids via `mailImap:resolveMessageIdsByUid`.
 */

import type { ConvexClient } from '../../convex.js';
import { fn } from '../../convex.js';

export async function collectMessageIds(
	convex: ConvexClient,
	folderId: string,
	ranges: ReadonlyArray<readonly [number, number]>,
): Promise<string[]> {
	const ids: string[] = [];
	for (const [low, high] of ranges) {
		const slice = (await convex.query(fn.resolveMessageIdsByUid as never, {
			folderId,
			uidLow: low,
			uidHigh: high,
		} as never)) as Array<{ _id: string }>;
		for (const row of slice) ids.push(row._id);
	}
	return ids;
}

/**
 * Resolve a single contiguous UID span to a `uid → mailMessages id` map via
 * one `resolveMessageIdsByUid` range query. Callers that hold an exact set of
 * resolved UIDs (e.g. STORE, after the seq↔UID map has interpreted the
 * request) pick the ids they need out of the map, so a contiguous set such as
 * `STORE 1:1000` costs a single Convex query instead of one per message —
 * mirroring the FETCH path's single min..max envelope query.
 */
export async function collectMessageIdsByUid(
	convex: ConvexClient,
	folderId: string,
	uidLow: number,
	uidHigh: number,
): Promise<Map<number, string>> {
	const slice = (await convex.query(fn.resolveMessageIdsByUid as never, {
		folderId,
		uidLow,
		uidHigh,
	} as never)) as Array<{ _id: string; uid: number }>;
	const byUid = new Map<number, string>();
	for (const row of slice) byUid.set(row.uid, row._id);
	return byUid;
}
