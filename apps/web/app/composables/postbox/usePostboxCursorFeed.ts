/**
 * Keyset-cursor feed for the Postbox "Load more" lists.
 *
 * Replaces the growable-limit pattern (re-subscribing with a bigger limit on
 * every page grow — O(total) per click) with true keyset pagination built from
 * TWO live subscriptions:
 *
 *   - the FIRST page, always subscribed without a cursor, so new mail keeps
 *     floating to the top no matter how far the user has paged;
 *   - the TAIL — one cursor-keyed subscription per "Load more" step. Each
 *     landed tail page is stored as a segment keyed by the cursor that opened
 *     it, so growing the tail never re-reads earlier pages.
 *
 * Rendered rows are the flattened, deduped union of the live first page and all
 * tail segments (first page wins ties, so a row the first page has grown to
 * include shows its freshest copy). Deeper-page segments update through their
 * own subscription while it is the active tail; older ones are stable snapshots
 * — the same tradeoff the Team Inbox list makes, with the visible top of the
 * list always live.
 *
 * The first page is read straight off its subscription rather than copied into
 * a segment, so `keepPreviousData` keeps working across a reset: a folder
 * switch drops the accumulated tail and keeps the previous rows on screen until
 * the new first page lands, instead of blanking the list.
 *
 * Two reset levels:
 *   - `resetKey` (folder switch, new search query) invalidates every minted
 *     cursor: the tail is dropped, the retained first page stays visible.
 *   - `hardResetKey` (mailbox switch) additionally SUPPRESSES the retained
 *     page, because those rows belong to another account and must never render
 *     under the new one. The list is empty until fresh data arrives.
 */

import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { ArgsOrFactory } from '~/composables/useConvexQuery';

/**
 * The structural slice of a cursor-paginated page this composable needs.
 *
 * `hasMore` is authoritative and `nextCursor` is not: a take()-bounded view
 * (the virtual Snoozed folder, `listByLabel`) reports `hasMore: true` with
 * `nextCursor: null` to mean "more matches exist, but this view has no cursor
 * to walk". Deriving "more exists" from the cursor alone silently caps those
 * views at one page.
 */
interface FeedPage {
	messages: Array<{ _id: string }>;
	hasMore?: boolean;
	nextCursor: string | null;
}

export function usePostboxCursorFeed<Query extends FunctionReference<'query'>>(
	query: Query,
	args: ArgsOrFactory<FunctionArgs<Query>>,
	resetKey: Ref<unknown>,
	options?: { keepPreviousData?: boolean; hardResetKey?: Ref<unknown> }
) {
	const resolveBaseArgs = (): FunctionArgs<Query> | 'skip' =>
		typeof args === 'function' ? (args as () => FunctionArgs<Query> | 'skip')() : args;

	// ── Live first page ─────────────────────────────────────────────────────
	const {
		data: firstData,
		isLoading,
		isRefetching,
		error,
	} = useConvexQuery(query, resolveBaseArgs, {
		keepPreviousData: options?.keepPreviousData ?? true,
	});

	// ── Tail: one cursor-keyed page per Load-more step ─────────────────────
	const tailCursor = ref<string | null>(null);
	/** Segment key for the tail page currently being fetched. */
	const tailKey = ref<string | null>(null);

	const {
		data: tailData,
		isLoading: tailLoading,
		error: tailError,
	} = useConvexQuery(
		query,
		() => {
			const resolved = resolveBaseArgs();
			if (resolved === 'skip' || !tailCursor.value) return 'skip';
			return { ...resolved, cursor: tailCursor.value } as FunctionArgs<Query>;
		},
		{ keepPreviousData: options?.keepPreviousData ?? true }
	);

	// Accumulation works over the structural page shape (a generic Query's
	// FunctionReturnType stays deferred inside the wrapper, so deriving row
	// types from it degrades to any); the precise row type is restored at the
	// boundary via `rows` below.
	type SegmentRows = Array<{ _id: string }>;
	const feedFirst = computed(() => firstData.value as unknown as FeedPage | undefined);
	const feedTail = computed(() => tailData.value as unknown as FeedPage | undefined);

	/** Loaded tail pages, keyed by the cursor that opened each (insertion-ordered). */
	const tailSegments = ref(new Map<string, SegmentRows>()) as Ref<Map<string, SegmentRows>>;

	/**
	 * Set by a hard reset, cleared by the next first-page delivery: while set,
	 * the retained page belongs to the PREVIOUS mailbox and must not render.
	 */
	const suppressRetained = ref(false);

	watch(feedTail, (page) => {
		if (!page || !tailKey.value) return;
		const next = new Map(tailSegments.value);
		next.set(tailKey.value, [...page.messages]);
		tailSegments.value = next;
	});
	watch(feedFirst, () => {
		suppressRetained.value = false;
	});

	/** The live first page's rows, or none while a hard reset is pending. */
	const firstRows = computed<SegmentRows>(() =>
		suppressRetained.value ? [] : (feedFirst.value?.messages ?? [])
	);

	const accumulated = computed(() => {
		const out: Array<{ _id: string }> = [];
		const seen = new Set<string>();
		const push = (rows: SegmentRows) => {
			for (const row of rows) {
				if (!seen.has(row._id)) {
					seen.add(row._id);
					out.push(row);
				}
			}
		};
		push(firstRows.value);
		for (const rows of tailSegments.value.values()) push(rows);
		return out;
	});

	// A resetKey change invalidates every minted cursor — drop the tail
	// synchronously, before the queries re-subscribe. The first page is left
	// alone so `keepPreviousData` can keep the previous rows on screen.
	watch(
		resetKey,
		() => {
			tailCursor.value = null;
			tailKey.value = null;
			tailSegments.value = new Map();
		},
		{ flush: 'sync' }
	);

	// A hard reset (mailbox switch) does the same AND hides the retained page.
	if (options?.hardResetKey) {
		watch(
			options.hardResetKey,
			() => {
				tailCursor.value = null;
				tailKey.value = null;
				tailSegments.value = new Map();
				suppressRetained.value = true;
			},
			{ flush: 'sync' }
		);
	}

	/** The page that owns the frontier: the deepest loaded one. */
	const frontier = computed<FeedPage | undefined>(() =>
		tailCursor.value ? feedTail.value : feedFirst.value
	);

	/** More rows exist beyond what is rendered (cursor-walkable or not). */
	const hasMore = computed(() => {
		const page = frontier.value;
		if (!page) return false;
		return page.hasMore ?? page.nextCursor !== null;
	});

	/** More rows exist AND there is a cursor to reach them. */
	const canLoadMore = computed(() => hasMore.value && frontier.value?.nextCursor != null);

	function loadMore() {
		const next = frontier.value?.nextCursor ?? null;
		if (!next) return;
		tailKey.value = next;
		tailCursor.value = next;
	}

	type Rows = FunctionReturnType<Query>['messages'];
	return {
		rows: computed(() => accumulated.value as Rows),
		/** True only while the FIRST page is pending — never during a Load more. */
		isLoading,
		/** True while a "Load more" page is in flight. */
		isLoadingMore: computed(() => (tailCursor.value ? tailLoading.value : false)),
		isRefetching,
		error: computed(() => error.value ?? tailError.value),
		hasMore,
		canLoadMore,
		loadMore,
	};
}
