/**
 * Team Inbox thread TEXT SEARCH — the `search` argument behind
 * `inbox.queries.listThreads`.
 *
 * The Team Inbox list page had no text search at all, yet its threads were
 * already being searched from two unrelated pickers (the chat "link an email
 * thread" dialog and the file thread picker), each pulling a bounded recent page
 * and filtering it in the browser. That client-side filter can only ever find
 * what happened to be on the page it fetched. This module is the server-side
 * replacement: the same two fields those filters matched — the subject and the
 * participant address — each on its own search index, merged here.
 *
 * Two indexes rather than one denormalized `searchableText` column because both
 * fields are written once at insert and never patched
 * (`inbox/threads/module.ts`), so a derived column would buy nothing but a
 * backfill and a drift risk. The merge is the price, and it is paid here, once.
 *
 * Shape: a bounded TOP-N, not a page. A Convex search index orders by relevance,
 * and relevance from two indexes cannot share one cursor — so the search path
 * reads a capped window from each, narrows it with the pill predicate, orders
 * the survivors by recency (the order the list already reads in) and stops.
 * `listThreads` reports `nextCursor: null` for it.
 *
 * The reading is three lines; everything that can be wrong is in the pure
 * `mergeThreadSearchHits`, which is what `__tests__/threadSearch.test.ts`
 * exercises — `convex-test` cannot run `withSearchIndex` at all.
 */

import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { threadMatchesFilter, type ThreadFilter } from './threadFilters';

/**
 * How many relevance-ranked rows are read from EACH search index before the
 * pill predicate narrows them. The cap bounds the read: a query that matches
 * ten thousand threads still costs two capped index reads, and the pill can
 * only ever thin the window, never widen it.
 */
export const THREAD_SEARCH_SCAN_CAP = 64;

/** Shortest query the search path will run — below this it returns nothing. */
export const THREAD_SEARCH_MIN_QUERY = 2;

export interface ThreadSearchOptions {
	/** Raw typed query. Trimmed here; blank means "no search". */
	search: string;
	/** The active pill, applied as a predicate rather than an index. */
	filter?: ThreadFilter;
	/** Viewer, for the `mine` slice. */
	userId: string;
	now: number;
	/** How many survivors to return. */
	limit: number;
}

/**
 * Dedupe two relevance-ranked hit lists, narrow them to the active pill, and
 * order the survivors newest-activity first.
 *
 * A thread whose subject AND participant both match appears in both lists; the
 * first sighting wins, so it is returned once. Ordering is by `lastMessageAt`
 * (with `_id` as the tie-break, so the order is total and a test is not hostage
 * to array order) rather than by either list's relevance rank: the two ranks
 * are not comparable across indexes, and the list this feeds reads in recency
 * order everywhere else. Pure.
 */
export function mergeThreadSearchHits(
	bySubject: ReadonlyArray<Doc<'conversationThreads'>>,
	byParticipant: ReadonlyArray<Doc<'conversationThreads'>>,
	options: Omit<ThreadSearchOptions, 'search'>
): Doc<'conversationThreads'>[] {
	const seen = new Set<string>();
	const survivors: Doc<'conversationThreads'>[] = [];
	for (const thread of [...bySubject, ...byParticipant]) {
		if (seen.has(thread._id)) continue;
		seen.add(thread._id);
		if (!threadMatchesFilter(thread, options.filter, options.userId, options.now)) continue;
		survivors.push(thread);
	}
	survivors.sort((a, b) => b.lastMessageAt - a.lastMessageAt || (a._id < b._id ? -1 : 1));
	return survivors.slice(0, Math.max(0, options.limit));
}

/**
 * Run the text search. Returns [] for a query shorter than
 * {@link THREAD_SEARCH_MIN_QUERY} so a single stray character never sweeps the
 * whole inbox into a dropdown.
 */
export async function searchThreads(
	ctx: QueryCtx,
	options: ThreadSearchOptions
): Promise<Doc<'conversationThreads'>[]> {
	const term = options.search.trim();
	if (term.length < THREAD_SEARCH_MIN_QUERY) return [];

	const [bySubject, byParticipant] = await Promise.all([
		ctx.db
			.query('conversationThreads')
			.withSearchIndex('search_thread_subject', (q) => q.search('subject', term))
			.take(THREAD_SEARCH_SCAN_CAP),
		ctx.db
			.query('conversationThreads')
			.withSearchIndex('search_thread_participant', (q) => q.search('contactIdentifier', term))
			.take(THREAD_SEARCH_SCAN_CAP),
	]);

	return mergeThreadSearchHits(bySubject, byParticipant, options);
}
