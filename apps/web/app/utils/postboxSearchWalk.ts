/**
 * "Search older mail": how far one click walks.
 *
 * Mail search reads the index a page at a time and filters each page after the
 * read, so a page can come back empty while older pages still hold matches.
 * The results page used to say so and stop, leaving the reader to press a
 * button once per page. One click now keeps walking until something matches,
 * the mailbox runs out, or a page budget is spent (so a query that matches
 * nothing in a huge mailbox cannot spin forever; the button comes back and the
 * next click walks another budget).
 *
 * Pure so the stopping rules are unit-testable without a Convex feed.
 */

/** Pages one click may read before handing control back to the reader. */
export const SEARCH_WALK_PAGE_BUDGET = 20;

export type SearchWalkStep =
	/** Ask for the next page now. */
	| 'load'
	/** A page is in flight: check again when it lands. */
	| 'wait'
	/** Found something, ran out of mail, failed, or spent the budget. */
	| 'stop';

export function searchWalkStep(state: {
	resultCount: number;
	hasMore: boolean;
	canLoadMore: boolean;
	isLoadingMore: boolean;
	hasError: boolean;
	pagesWalked: number;
}): SearchWalkStep {
	if (state.resultCount > 0 || state.hasError) return 'stop';
	// Checked before `hasMore`: while a page is in flight the feed still reports
	// the previous page's frontier.
	if (state.isLoadingMore) return 'wait';
	if (!state.hasMore || !state.canLoadMore) return 'stop';
	return state.pagesWalked >= SEARCH_WALK_PAGE_BUDGET ? 'stop' : 'load';
}
