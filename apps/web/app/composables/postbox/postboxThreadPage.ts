/**
 * How the reader pages a long conversation (plan 3.3), as pure helpers.
 *
 * `listThreadMessages` returns a thread newest first in pages. Of the newest
 * page only the newest {@link THREAD_PAGE_BODIES} messages come with their
 * bodies; the older ones, and every message of an earlier page, arrive as
 * envelopes (list rows without a body). The reader renders an envelope as a
 * collapsed row and loads its body when it is expanded.
 *
 * The reader, the route-level open (`usePostboxOpenMessage`) and the list
 * read-ahead (`usePostboxPrefetch`) all subscribe the newest page with
 * {@link threadPageArgs}, so they share one subscription.
 */
import type { Id } from '@owlat/api/dataModel';

/** Messages per page, newest first. */
export const THREAD_PAGE_SIZE = 50;
/** How many of the newest page's messages come with their bodies. */
export const THREAD_PAGE_BODIES = 10;
/**
 * How many earlier pages the reader loads by itself to reach the message it
 * was opened on. Past that, the opened message still shows (see
 * {@link placeAnchorRow}) and the rest waits for "Load earlier".
 */
export const THREAD_ANCHOR_PAGE_LIMIT = 10;

/** Args of the newest page, shared by every subscriber of the open thread. */
export function threadPageArgs(messageId: string) {
	return {
		messageId: messageId as Id<'mailMessages'>,
		pageSize: THREAD_PAGE_SIZE,
		withBodies: THREAD_PAGE_BODIES,
	};
}

/** Args of an earlier page: envelopes only, from the previous page's cursor. */
export function earlierThreadPageArgs(messageId: string, cursor: string) {
	return {
		messageId: messageId as Id<'mailMessages'>,
		pageSize: THREAD_PAGE_SIZE,
		withBodies: 0,
		cursor,
	};
}

/** The part of a thread page the merge reads. */
export interface ThreadPageRows<Row extends { _id: string }> {
	messages: readonly Row[];
	envelopes: readonly Row[];
}

/**
 * The loaded pages as one conversation, oldest first. `pages` runs newest
 * first. The newest page is not pinned to a cursor, so a new reply shifts its
 * oldest message into the earlier page; a message both pages hold keeps the
 * newer page's copy, which may carry its body.
 */
export function mergeThreadPages<Row extends { _id: string }>(
	pages: ReadonlyArray<ThreadPageRows<Row>>
): Row[] {
	const seen = new Set<string>();
	const chunks: Row[][] = [];
	for (const page of pages) {
		const chunk: Row[] = [];
		for (const row of [...page.envelopes, ...page.messages]) {
			if (seen.has(row._id)) continue;
			seen.add(row._id);
			chunk.push(row);
		}
		chunks.push(chunk);
	}
	return chunks.reverse().flat();
}

/**
 * The conversation with the message the reader was opened on in it. The
 * opened message can sit in a page not loaded yet (a search hit deep in a
 * long thread); until it arrives, the row the reader was opened with stands
 * in at its place by date, so the reader never shows a thread without it.
 */
export function placeAnchorRow<Row extends { _id: string; receivedAt: number }>(
	rows: readonly Row[],
	anchor: Row
): Row[] {
	if (rows.some((row) => row._id === anchor._id)) return [...rows];
	const at = rows.findIndex((row) => row.receivedAt > anchor.receivedAt);
	const out = [...rows];
	out.splice(at === -1 ? out.length : at, 0, anchor);
	return out;
}
