/**
 * Paged reads of a folder from the Convex side.
 *
 * Convex reads whole documents and caps one execution at 16,384 documents /
 * 8 MiB, so "give me the folder" is not a query a real INBOX survives — the
 * backend serves pages (`mail/imap/fetch`) and these helpers stitch them back
 * together for the command modules.
 *
 * **A page walk is not a snapshot.** The old single `.collect()` handed
 * `buildSeqMap` an atomic view of the folder; N pages are N transactions, so a
 * concurrent EXPUNGE can remove a message from a page already read, leaving a
 * UID in the map that no longer resolves — FETCH then drops that row from the
 * response. That exposure is a narrower form of one the server already accepts
 * (the map has always been rebuilt per command, and already raced the separate
 * envelope read), and it is bounded by the same rule that makes it tolerable:
 * sequence numbers are only promised to hold for the command that computed
 * them. The tearing window grows from one query to a few; it does not become a
 * new class of error.
 *
 * The UID list is deliberately NOT cached across commands. Another session's
 * EXPUNGE shifts every sequence number above it, so a map kept from an earlier
 * command makes `FETCH 2` address the wrong message — a correctness bug that
 * stays invisible until it hits mail. There is no per-session UID cache to
 * extend either: IDLE keeps its own `lastUids`, but that is the *client's*
 * view, kept deliberately stale so expunge diffs resolve against the sequence
 * numbers the client still holds.
 */

import type { ConvexClient } from '../../convex.js';
import { fn } from '../../convex.js';
import type { FetchEnvelope } from '../fetch/format.js';

/**
 * Safety valve on every paging loop. A walk that never reports completion — a
 * backend contract change, a cursor that stops advancing, a folder growing
 * faster than it can be read — must FAIL the command, never return a prefix:
 * a truncated UID list answered with a tagged OK tells the client its mailbox
 * ends there. Callers wrap their body in try/catch and answer BAD (IDLE logs
 * and skips the tick), which is the honest protocol outcome.
 *
 * At the backend's page sizes this is ~500k UIDs / ~100k envelopes, i.e. a
 * ceiling no real mailbox reaches before the error means what it says.
 */
const MAX_PAGES = 500;

/** Raised when a paging walk cannot be completed. Surfaces as BAD, not OK. */
class PagingError extends Error {}

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

/**
 * Next UID-ordered read position, or `null` when the walk is done. Throws
 * rather than looping if the backend hands back a resume point that does not
 * advance — 500 identical round trips ending in a truncated answer is strictly
 * worse than failing on the first one.
 */
function advance(nextUid: number | null, from: number, what: string): number | null {
	if (nextUid === null) return null;
	if (nextUid <= from) {
		throw new PagingError(`${what}: resume point ${nextUid} did not advance past ${from}`);
	}
	return nextUid;
}

function exhausted(what: string): never {
	throw new PagingError(`${what}: exceeded ${MAX_PAGES} pages`);
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
		const next = advance(result.nextUid, afterUid ?? 0, 'listFolderUidsPage');
		if (next === null) return uids;
		afterUid = next;
	}
	exhausted('listFolderUidsPage');
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
		const next = advance(result.nextUid, low, 'fetchEnvelopes');
		if (next === null || next > uidHigh) return rows;
		low = next;
	}
	exhausted('fetchEnvelopes');
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
		const next = advance(result.nextUid, low, 'resolveMessageIdsByUid');
		if (next === null || next > uidHigh) return rows;
		low = next;
	}
	exhausted('resolveMessageIdsByUid');
}

/**
 * Every row whose modseq advanced past `modseqSince` — today the IDLE poll's
 * read, and what a `FETCH … (CHANGEDSINCE n)` parser would call when it lands.
 * Served off `by_folder_and_modseq`, so the cost tracks what changed, not how
 * big the folder is.
 *
 * Returned ascending by UID, not in the index's modseq (write) order: the
 * unsolicited `* n FETCH` lines IDLE builds from these rows used to come out in
 * sequence order, and nothing is gained by making that output depend on the
 * order flags happened to be written in.
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
		if (result.isDone || result.continueCursor === null) {
			return rows.sort((a, b) => a.uid - b.uid);
		}
		if (result.continueCursor === cursor) {
			throw new PagingError('fetchChangedEnvelopes: cursor did not advance');
		}
		cursor = result.continueCursor;
	}
	exhausted('fetchChangedEnvelopes');
}
