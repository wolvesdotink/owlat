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
 * {@link loadFolderUids} itself caches nothing. Another session's EXPUNGE
 * shifts every sequence number above it, so a UID list kept from an earlier
 * command, unchecked, makes `FETCH 2` address the wrong message. Reuse lives in
 * `membership.ts`, which keeps a list only under the folder's membership
 * version and asks the backend whether that version still holds; this walk is
 * its fallback for folders the backend does not maintain yet. The client's own
 * numbering is a third thing again, the session's `SequenceView`, kept
 * deliberately behind the folder until changes are announced to it.
 */

import {
	fn,
	type ChangedEnvelopePage,
	type ConvexClient,
	type MessageIdPage,
} from '../../convex.js';
import type { FetchEnvelope } from '../fetch/format.js';

/**
 * Safety valve on every paging loop. A walk that never reports completion — a
 * backend contract change, a cursor that stops advancing, a folder growing
 * faster than it can be read — must FAIL the command, never return a prefix:
 * a truncated UID list answered with a tagged OK tells the client its mailbox
 * ends there. Callers wrap their body in try/catch and answer BAD (IDLE logs
 * and skips the tick), which is the honest protocol outcome.
 *
 * At the backend's page size this is ~500k UIDs, a ceiling no real mailbox
 * reaches before the error means what it says. Range walks derive their
 * ceiling from the request instead (see `walkUidRanges`).
 */
const MAX_PAGES = 500;

/** Raised when a paging walk cannot be completed. Surfaces as BAD, not OK. */
class PagingError extends Error {}

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

function exhausted(what: string, pages: number = MAX_PAGES): never {
	throw new PagingError(`${what}: exceeded ${pages} pages`);
}

/**
 * Every UID in a folder, ascending — the sequence ↔ UID map's input.
 *
 * `signal` (optional) is checked before each page: once the command's
 * connection has gone, the walk throws the abort reason instead of reading
 * pages nobody will receive.
 */
export async function loadFolderUids(
	convex: ConvexClient,
	folderId: string,
	signal?: AbortSignal
): Promise<number[]> {
	const uids: number[] = [];
	let afterUid: number | undefined;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		signal?.throwIfAborted();
		const result = await convex.query(fn.listFolderUidsPage, {
			folderId,
			...(afterUid === undefined ? {} : { afterUid }),
		});
		uids.push(...result.uids);
		const next = advance(result.nextUid, afterUid ?? 0, 'listFolderUidsPage');
		if (next === null) return uids;
		afterUid = next;
	}
	exhausted('listFolderUidsPage');
}

/** An inclusive UID range; a set of them is ascending and disjoint. */
export interface UidRange {
	readonly low: number;
	readonly high: number;
}

/**
 * Sub-ranges sent per windowed read. Matches the backend's cap
 * (`MAX_UID_RANGES` in apps/api `mail/imap/fetch.ts`); the backend's row limit
 * still bounds each page, so this only bounds the argument size.
 */
export const MAX_RANGES_PER_READ = 100;

type WindowRead<Row> = (window: {
	uidLow: number;
	uidHigh: number;
	ranges?: Array<{ low: number; high: number }>;
}) => Promise<{ rows: Row[]; nextUid: number | null }>;

/**
 * Walk `ranges` in bounded windowed reads and yield each page's rows as it
 * arrives, ascending by UID.
 *
 * Each call carries up to {@link MAX_RANGES_PER_READ} ranges, and the backend
 * reads only rows inside them — so a sparse set costs reads for the messages
 * it names, not for everything between its smallest and largest UID. A full
 * page resumes at `nextUid` inside the same ranges; ranges entirely below it
 * are not sent again. One range goes out as a plain window, the read a
 * contiguous set such as `1:*` has always made.
 *
 * `expectedRows` bounds the walk: every page that does not finish its ranges
 * is full and carries at least one new row, so more pages than
 * `expectedRows` plus one per batch means the backend is not advancing, and
 * the walk fails rather than looping (see {@link MAX_PAGES}).
 */
async function* walkUidRanges<Row>(
	ranges: readonly UidRange[],
	expectedRows: number,
	read: WindowRead<Row>,
	what: string,
	signal?: AbortSignal
): AsyncGenerator<Row[]> {
	const maxPages = expectedRows + Math.ceil(ranges.length / MAX_RANGES_PER_READ) + 1;
	let i = 0;
	let cursor = ranges[0]?.low ?? 0;
	for (let page = 0; page < maxPages; page += 1) {
		const first = ranges[i];
		if (first === undefined) return;
		signal?.throwIfAborted();
		const batch = ranges.slice(i, i + MAX_RANGES_PER_READ);
		const uidLow = Math.max(cursor, first.low);
		const uidHigh = batch[batch.length - 1]!.high;
		const result = await read(
			batch.length === 1
				? { uidLow, uidHigh }
				: { uidLow, uidHigh, ranges: batch.map(({ low, high }) => ({ low, high })) }
		);
		if (result.rows.length > 0) yield result.rows;
		const next = advance(result.nextUid, uidLow, what);
		if (next === null || next > uidHigh) {
			i += batch.length;
		} else {
			while (i < ranges.length && ranges[i]!.high < next) i += 1;
			cursor = next;
		}
	}
	if (i < ranges.length) exhausted(what, maxPages);
}

/**
 * The envelopes of `ranges`, one page at a time, ascending by UID. FETCH emits
 * each page before asking for the next, so neither the first response nor the
 * sidecar's memory waits on the whole set. Aborts like {@link loadFolderUids}.
 */
export function streamEnvelopes(
	convex: ConvexClient,
	folderId: string,
	ranges: readonly UidRange[],
	expectedRows: number,
	signal?: AbortSignal
): AsyncGenerator<FetchEnvelope[]> {
	return walkUidRanges(
		ranges,
		expectedRows,
		async (window) => await convex.query(fn.fetchEnvelopes, { folderId, ...window }),
		'fetchEnvelopes',
		signal
	);
}

/** Every `{ _id, uid, modseq }` in `ranges`, ascending by UID. */
export async function loadMessageIds(
	convex: ConvexClient,
	folderId: string,
	ranges: readonly UidRange[],
	expectedRows: number
): Promise<MessageIdPage['rows']> {
	const rows: MessageIdPage['rows'] = [];
	const pages = walkUidRanges(
		ranges,
		expectedRows,
		async (window) => await convex.query(fn.resolveMessageIdsByUid, { folderId, ...window }),
		'resolveMessageIdsByUid'
	);
	for await (const page of pages) rows.push(...page);
	return rows;
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
 *
 * Aborts like {@link loadFolderUids}: `signal` is checked before each page.
 */
export async function loadChangedEnvelopes(
	convex: ConvexClient,
	folderId: string,
	modseqSince: number,
	signal?: AbortSignal,
	pageSize = 200
): Promise<FetchEnvelope[]> {
	const rows: FetchEnvelope[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		signal?.throwIfAborted();
		// Annotated: `cursor` is fed back from `result`, which TypeScript cannot
		// infer through the generic call.
		const result: ChangedEnvelopePage = await convex.query(fn.fetchChangedEnvelopes, {
			folderId,
			modseqSince,
			paginationOpts: { numItems: pageSize, cursor },
		});
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
