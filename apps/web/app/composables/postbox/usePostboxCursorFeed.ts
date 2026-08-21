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
 * Rendered rows are the flattened, deduped union of all segments (first-page
 * wins ties, so a row the first page has grown to include shows its freshest
 * copy). Deeper-page segments update through their own subscription while it
 * is the active tail; older ones are stable snapshots — the same tradeoff the
 * Team Inbox list makes, with the visible top of the list always live.
 *
 * A change of `resetKey` (folder switch, new search query) drops back to a
 * fresh first page synchronously, before the queries re-subscribe.
 */

import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';
import type { ArgsOrFactory } from '~/composables/useConvexQuery';

/** The structural slice of a cursor-paginated page this composable needs. */
interface FeedPage {
	messages: Array<{ _id: string }>;
	nextCursor: string | null;
}

export function usePostboxCursorFeed<Query extends FunctionReference<'query'>>(
	query: Query,
	args: ArgsOrFactory<FunctionArgs<Query>>,
	resetKey: Ref<unknown>,
	options?: { keepPreviousData?: boolean }
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

	const segments = ref(new Map<string, SegmentRows>()) as Ref<Map<string, SegmentRows>>;

	watch(
		feedFirst,
		(page) => {
			if (!page) return;
			const next = new Map(segments.value);
			next.set('', [...page.messages]);
			segments.value = next;
		},
		{ immediate: true }
	);
	watch(
		feedTail,
		(page) => {
			if (!page || !tailKey.value) return;
			const next = new Map(segments.value);
			next.set(tailKey.value, [...page.messages]);
			segments.value = next;
		},
		{ immediate: true }
	);

	const accumulated = computed(() => {
		const out: Array<{ _id: string }> = [];
		const seen = new Set<string>();
		for (const rows of segments.value.values()) {
			for (const row of rows) {
				if (!seen.has(row._id)) {
					seen.add(row._id);
					out.push(row);
				}
			}
		}
		return out;
	});

	// A resetKey change invalidates every minted cursor — restart from a fresh
	// first page synchronously, before the queries re-subscribe.
	watch(
		resetKey,
		() => {
			tailCursor.value = null;
			tailKey.value = null;
			segments.value = new Map();
		},
		{ flush: 'sync' }
	);

	function loadMore() {
		const next = tailCursor.value
			? // Extending an existing tail: continue from its latest page.
				(feedTail.value?.nextCursor ?? null)
			: // First extension: continue from the live first page.
				(feedFirst.value?.nextCursor ?? null);
		if (!next) return;
		tailKey.value = next;
		tailCursor.value = next;
	}

	const hasMore = computed(() => {
		if (!tailCursor.value) return !!feedFirst.value?.nextCursor;
		return !!feedTail.value?.nextCursor;
	});

	type Rows = FunctionReturnType<Query>['messages'];
	return {
		rows: computed(() => accumulated.value as Rows),
		isLoading: computed(() => (tailCursor.value ? tailLoading.value || isLoading.value : isLoading.value)),
		isRefetching,
		error: computed(() => error.value ?? tailError.value),
		hasMore,
		loadMore,
	};
}
