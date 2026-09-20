/**
 * Paged reads of a folder from the Convex side.
 *
 * Convex reads whole documents and caps one execution at 16,384 documents /
 * 8 MiB, so "give me the folder" is not a query a real INBOX survives — the
 * backend serves pages (`mail/imap/fetch`) and these helpers stitch them back
 * together for the command modules.
 *
 * The UID list is deliberately NOT cached across commands. The sequence ↔ UID
 * map has to reflect the folder as it is *now*: another session's EXPUNGE or a
 * fresh delivery shifts every sequence number above it, and a stale map makes
 * `FETCH 2` address the wrong message — a correctness bug that is invisible
 * until it hits mail. There is no per-session UID cache to extend either (IDLE
 * keeps its own `lastUids` snapshot, but that is the *client's* view, kept
 * deliberately stale so expunge diffs resolve against the sequence numbers the
 * client still holds). Paging keeps the cost per command bounded instead.
 */

import type { ConvexClient } from '../../convex.js';
import { fn } from '../../convex.js';
import type { FetchEnvelope } from '../fetch/format.js';

/**
 * Safety valve on every paging loop: a page that never reports completion
 * (a backend contract change, a folder growing faster than we read it) must
 * end the command, not spin the worker forever.
 */
const MAX_PAGES = 500;

interface UidPage {
	readonly uids: number[];
	readonly nextUid: number | null;
}

interface EnvelopePage {
	readonly rows: FetchEnvelope[];
	readonly nextUid: number | null;
}

interface MessageIdPage {
	readonly rows: Array<{ _id: string; uid: number; modseq: number }>;
	readonly nextUid: number | null;
}

interface ChangedPage {
	readonly page: FetchEnvelope[];
	readonly isDone: boolean;
	readonly continueCursor: string | null;
}

/** Every UID in a folder, ascending — the sequence ↔ UID map's input. */
export async function loadFolderUids(convex: ConvexClient, folderId: string): Promise<number[]> {
	const uids: number[] = [];
	let afterUid: number | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const result = (await convex.query(
			fn.listFolderUidsPage as never,
			{
				folderId,
				...(afterUid === undefined ? {} : { afterUid }),
			} as never
		)) as UidPage;
		uids.push(...result.uids);
		if (result.nextUid === null) break;
		afterUid = result.nextUid;
	}
	return uids;
}

/** Every envelope in a UID window, ascending by UID. */
export async function loadEnvelopes(
	convex: ConvexClient,
	folderId: string,
	uidLow: number,
	uidHigh: number
): Promise<FetchEnvelope[]> {
	const rows: FetchEnvelope[] = [];
	let low = uidLow;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const result = (await convex.query(
			fn.fetchEnvelopes as never,
			{
				folderId,
				uidLow: low,
				uidHigh,
			} as never
		)) as EnvelopePage;
		rows.push(...result.rows);
		if (result.nextUid === null || result.nextUid > uidHigh) break;
		low = result.nextUid;
	}
	return rows;
}

/** Every `{ _id, uid, modseq }` in a UID window, ascending by UID. */
export async function loadMessageIds(
	convex: ConvexClient,
	folderId: string,
	uidLow: number,
	uidHigh: number
): Promise<MessageIdPage['rows']> {
	const rows: MessageIdPage['rows'] = [];
	let low = uidLow;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const result = (await convex.query(
			fn.resolveMessageIdsByUid as never,
			{
				folderId,
				uidLow: low,
				uidHigh,
			} as never
		)) as MessageIdPage;
		rows.push(...result.rows);
		if (result.nextUid === null || result.nextUid > uidHigh) break;
		low = result.nextUid;
	}
	return rows;
}

/**
 * Every row whose modseq advanced past `modseqSince` — CONDSTORE's
 * `CHANGEDSINCE` and the IDLE poll. Served off `by_folder_and_modseq`, so the
 * cost tracks what changed, not how big the folder is.
 */
export async function loadChangedEnvelopes(
	convex: ConvexClient,
	folderId: string,
	modseqSince: number,
	pageSize = 200
): Promise<FetchEnvelope[]> {
	const rows: FetchEnvelope[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const result = (await convex.query(
			fn.fetchChangedEnvelopes as never,
			{
				folderId,
				modseqSince,
				paginationOpts: { numItems: pageSize, cursor },
			} as never
		)) as ChangedPage;
		rows.push(...result.page);
		if (result.isDone || result.continueCursor === null) break;
		cursor = result.continueCursor;
	}
	return rows;
}
