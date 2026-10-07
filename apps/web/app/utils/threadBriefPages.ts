/**
 * The brief's item pages, merged (SPEC §7). `brief.get` returns the thread's
 * open items a page at a time (`page.cursor`), the recently closed ones on the
 * first page only. The reader walks the pages on its own, up to a bound, and
 * merges their lists back into the "For you" order, so a payment obligation
 * past a page of waiting items is never hidden. Until every page is in, or
 * when the bound cut the walk, it says so (`itemsState`) and the Overview
 * never claims there is nothing to do. Pure.
 */
import { compareForYou } from '@owlat/shared/threadBriefRules';
import type {
	BriefItemView,
	BriefModeView,
	ThreadBriefView,
} from '../../../api/convex/mail/interpret/briefShape';

/** Item pages the reader walks at most (100 open items each). */
export const BRIEF_MAX_PAGES = 10;

/** Whether the item lists are whole. */
export type BriefItemsState = 'complete' | 'loading' | 'truncated';

export interface PagedBrief {
	brief: BriefModeView;
	itemsState: BriefItemsState;
	/** The recently closed items were cut (first page). */
	isClosedTruncated: boolean;
}

function sortable(item: BriefItemView) {
	return { due: item.due, facets: item.facets, askedAt: item.askedAt, id: item.id };
}

/** One list across pages: open items in the "For you" order, then the closed ones as given. */
function mergeList(lists: ReadonlyArray<readonly BriefItemView[]>): BriefItemView[] {
	const seen = new Set<string>();
	const all: BriefItemView[] = [];
	for (const list of lists) {
		for (const item of list) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			all.push(item);
		}
	}
	const open = all
		.filter((i) => i.status === 'open')
		.sort((a, b) => compareForYou(sortable(a), sortable(b)));
	return [...open, ...all.filter((i) => i.status !== 'open')];
}

/** The cursor of the page after `view`, or null when it was the last. */
export function nextCursorOf(view: ThreadBriefView | null | undefined): string | null {
	return view?.page && !view.page.isDone ? view.page.cursor : null;
}

/**
 * Merge the first page with the later ones (in cursor order; `undefined` = a
 * page still loading). Pure.
 */
export function mergeBriefPages(
	first: BriefModeView,
	later: ReadonlyArray<ThreadBriefView | null | undefined>,
	maxPages: number = BRIEF_MAX_PAGES
): PagedBrief {
	const loaded: BriefModeView[] = [first];
	let isLoading = false;
	for (const view of later) {
		if (view === undefined) {
			isLoading = true;
			break;
		}
		if (!view || view.mode !== 'brief') break;
		loaded.push(view);
	}
	const last = loaded[loaded.length - 1]!;
	const hasMore = nextCursorOf(last) !== null;
	const itemsState: BriefItemsState = !hasMore
		? 'complete'
		: isLoading || loaded.length < maxPages
			? 'loading'
			: 'truncated';
	const brief: BriefModeView =
		loaded.length === 1
			? first
			: {
					...first,
					forYou: mergeList(loaded.map((v) => v.forYou)),
					waitingOnOthers: mergeList(loaded.map((v) => v.waitingOnOthers)),
					unclear: mergeList(loaded.map((v) => v.unclear)),
				};
	return { brief, itemsState, isClosedTruncated: first.page?.isClosedTruncated === true };
}
