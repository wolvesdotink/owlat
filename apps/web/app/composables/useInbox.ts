import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import {
	DEFAULT_INBOX_SORT,
	inboxAssigneeArg,
	inboxAssigneeToQuery,
	inboxFilterToQuery,
	legacyInboxSort,
	nextInboxSort,
	parseInboxAssignee,
	parseInboxFilter,
	resolveInboxSort,
	type InboxAssignee,
	type InboxFilter,
	type InboxSort,
} from '~/utils/inboxFilters';
import { rememberTeamThreadPreviews } from '~/utils/teamThreadPreviews';

const SORT_STORAGE_KEY = 'inbox-thread-sort';

/**
 * The shared-inbox read surface. `gate` (optional) implements the
 * check-before-subscribe rule for the admin-only inbox: while it is false —
 * the role not yet resolved, or the member not an admin — none of the three
 * queries subscribe at all ('skip'), so a non-admin never briefly renders a
 * fake "queue is clear" zero and an admin's first paint waits out the role
 * read instead. The backend returns empty lists to non-admins by design; this
 * keeps even those empty reads off the wire.
 */
export function useInbox(gate?: Ref<boolean>) {
	const route = useRoute();
	const router = useRouter();
	const subscribed = () => !gate || gate.value;

	// ── Filter state, mirrored in the URL (`?filter=` status tab, `?assignee=`) ──
	// Reads seed from the current query; writes replace the query (shareable,
	// bookmarkable, back/forward works, and the default view stays bare). A
	// legacy `?filter=mine|unassigned|waiting-24h` link seeds the assignment
	// (or the oldest-waiting order) it used to mean.
	const filter = ref<InboxFilter>(parseInboxFilter(route.query['filter']));
	const assignee = ref<InboxAssignee>(
		parseInboxAssignee(route.query['assignee'], route.query['filter'])
	);

	watch(
		() => [route.query['filter'], route.query['assignee']] as const,
		([rawFilter, rawAssignee]) => {
			const nextFilter = parseInboxFilter(rawFilter);
			if (nextFilter !== filter.value) filter.value = nextFilter;
			const nextAssignee = parseInboxAssignee(rawAssignee, rawFilter);
			if (nextAssignee !== assignee.value) assignee.value = nextAssignee;
		}
	);
	watch([filter, assignee], ([nextFilter, nextAssignee]) => {
		const desired = {
			filter: inboxFilterToQuery(nextFilter),
			assignee: inboxAssigneeToQuery(nextAssignee),
		};
		const first = (raw: unknown) => (Array.isArray(raw) ? raw[0] : raw) ?? undefined;
		if (
			first(route.query['filter']) === desired.filter &&
			first(route.query['assignee']) === desired.assignee
		) {
			return;
		}
		const query = { ...route.query };
		for (const key of ['filter', 'assignee'] as const) {
			const value = desired[key];
			if (value === undefined) delete query[key];
			else query[key] = value;
		}
		void router.replace({ query });
	});

	// ── Sort preference, persisted per user (a6 mechanism = useLocalStorage) ──
	const { data: storedSort, set: setStoredSort } = useLocalStorage<InboxSort>(
		SORT_STORAGE_KEY,
		DEFAULT_INBOX_SORT
	);
	// Normalised on read: the stored value predates the "oldest waiting" order,
	// and a browser holding something unknown must not select a nonexistent
	// backend index.
	// `?filter=waiting-24h` used to be a tab; it now means "Open, longest wait
	// first". That order holds for this view only: following an old link must
	// not rewrite the viewer's saved sort. Picking a sort drops the override.
	const legacySort = ref<InboxSort | null>(legacyInboxSort(route.query['filter']) ?? null);

	// Response targets (SLA): filled from `getListSummary` below, read here by
	// the sort (the "due first" order exists only while targets are on).
	const slaSummary = shallowRef<FunctionReturnType<
		typeof api.inbox.sla.queries.getListSummary
	> | null>(null);
	const isSlaEnabled = computed(() => slaSummary.value?.isEnabled === true);

	// A saved "due first" order falls back to the default while targets are off:
	// without deadlines it would only repeat "oldest waiting" under another name.
	const sort = computed<InboxSort>(() => {
		const chosen = legacySort.value ?? resolveInboxSort(storedSort.value);
		return chosen === 'due' && !isSlaEnabled.value ? DEFAULT_INBOX_SORT : chosen;
	});
	const setSort = (next: InboxSort) => {
		legacySort.value = null;
		setStoredSort(next);
	};
	const toggleSort = () => {
		setSort(nextInboxSort(sort.value, isSlaEnabled.value));
	};

	// ── Thread list (keyset pagination; the args pick the backend index) ──
	// Two subscriptions, the same shape as the Postbox feed
	// (composables/postbox/usePostboxCursorFeed.ts):
	//   - the FIRST page never carries a cursor, so it stays live however far
	//     the list has been paged: a new thread still floats to the top;
	//   - the TAIL is one cursor-keyed page per "Load more". Each landed tail
	//     page is kept as a segment under the cursor that opened it, so paging
	//     deeper never re-reads the pages above. Only the newest segment stays
	//     live; older ones are snapshots.
	// keepPreviousData on the first page: a filter, assignee or sort change
	// keeps the rows on screen until the new first page lands, instead of
	// blanking the list to its skeleton.
	const listArgs = () => {
		if (!subscribed()) return 'skip' as const;
		const assigneeArg = inboxAssigneeArg(assignee.value);
		return {
			filter: filter.value,
			...(assigneeArg ? { assignee: assigneeArg } : {}),
			sort: sort.value,
			limit: 25,
		};
	};
	const {
		data: threadsData,
		isLoading: threadsLoading,
		isRefetching: threadsRefetching,
		error: firstPageError,
		refetch: refetchFirstPage,
	} = useConvexQuery(api.inbox.queries.listThreads, listArgs, { keepPreviousData: true });

	type Thread = NonNullable<typeof threadsData.value>['threads'][number];

	// Lets the thread page head its loading state with the list row: every
	// landed first page is recorded here, every tail page in the segment store.
	watch(
		threadsData,
		(data) => {
			if (data) rememberTeamThreadPreviews(data.threads);
		},
		{ immediate: true }
	);

	/** Cursor of the tail page being read; null = no page past the first. */
	const tailCursor = ref<string | null>(null);
	// No keepPreviousData here: a new cursor starts from a blank page, so every
	// landed page is a fresh delivery the segment store below sees.
	const {
		data: tailData,
		error: tailError,
		refetch: refetchTail,
	} = useConvexQuery(api.inbox.queries.listThreads, () => {
		const base = listArgs();
		if (base === 'skip' || !tailCursor.value) return 'skip';
		return { ...base, cursor: tailCursor.value };
	});

	/** Landed tail pages, keyed by the cursor that opened each (in page order). */
	// Sync flush: a cursor used before (back to a view, then "Load more" again)
	// re-subscribes to a lingering shared query, which clears the page and hands
	// back the very same object within one tick. A deferred watcher would compare
	// equal values and miss the page. Sync also means a value always belongs to
	// the cursor that was current when it was assigned.
	const tailSegments = shallowRef(new Map<string, Thread[]>());
	watch(
		tailData,
		(page) => {
			const key = tailCursor.value;
			if (!page || !key) return;
			rememberTeamThreadPreviews(page.threads);
			const next = new Map(tailSegments.value);
			next.set(key, page.threads);
			tailSegments.value = next;
		},
		{ flush: 'sync' }
	);

	// The rows below the first page when the view changed. They stay under the
	// retained first page until the new first page lands, so switching a filter
	// from deep in the list does not shrink it to one page and back.
	const retainedTail = shallowRef<Thread[]>([]);
	const dropSettledRetainedTail = () => {
		if (!threadsRefetching.value && retainedTail.value.length > 0) retainedTail.value = [];
	};
	watch(threadsRefetching, dropSettledRetainedTail);
	// A re-subscribe answered at once (a warm shared subscription) never raises
	// isRefetching, so also check once the queries have re-subscribed.
	watch(retainedTail, dropSettledRetainedTail, { flush: 'post' });

	// A filter, assignee or sort change selects a different backend index or
	// order, so every cursor minted for the prior view is invalid. Drop the tail
	// synchronously, before the queries re-subscribe.
	watch(
		[filter, assignee, sort],
		() => {
			// A second change before the first view landed keeps what is on screen.
			const onScreen = threadsRefetching.value ? retainedTail.value : [];
			retainedTail.value = [...onScreen, ...[...tailSegments.value.values()].flat()];
			tailCursor.value = null;
			tailSegments.value = new Map();
		},
		{ flush: 'sync' }
	);

	// The live first page, then every tail segment, deduped by _id: the first
	// page wins, so a row it has grown to include shows its freshest copy.
	const threads = computed<Thread[]>(() => {
		const out: Thread[] = [];
		const seen = new Set<string>();
		const push = (rows: readonly Thread[]) => {
			for (const row of rows) {
				if (seen.has(row._id)) continue;
				seen.add(row._id);
				out.push(row);
			}
		};
		push(threadsData.value?.threads ?? []);
		if (threadsRefetching.value) push(retainedTail.value);
		for (const rows of tailSegments.value.values()) push(rows);
		return out;
	});

	/** The deepest landed page: its cursor continues the list. */
	const frontier = computed(() => {
		const key = tailCursor.value;
		if (!key) return threadsData.value;
		return tailSegments.value.has(key) ? tailData.value : undefined;
	});
	// While a new view loads, the first page on screen belongs to the previous
	// args: its cursor would page the NEW view from an old view's position. And
	// while a tail page loads there is no frontier yet.
	const hasMoreThreads = computed(() => !threadsRefetching.value && !!frontier.value?.nextCursor);
	const threadsError = computed(() => firstPageError.value ?? tailError.value);
	/** Try again on `threadsError`: re-reads whichever page failed. */
	const retryThreads = () => {
		if (firstPageError.value) refetchFirstPage();
		if (tailError.value) refetchTail();
	};

	// ── Filter-pill counts (bounded reads; a slice at the cap renders "99+") ──
	// keepPreviousData: an assignee change keeps the old counts until the new ones land.
	const { data: filterCounts } = useConvexQuery(
		api.inbox.queries.getThreadFilterCounts,
		() => {
			if (!subscribed()) return 'skip';
			const assigneeArg = inboxAssigneeArg(assignee.value);
			return assigneeArg ? { assignee: assigneeArg } : {};
		},
		{ keepPreviousData: true }
	);

	// Review-queue badge count (drafts ready) — a real pipeline counter, retained
	// even though the old 8-cell stats grid is gone.
	const { data: stats } = useConvexQuery(api.inbox.queries.getInboundStats, () =>
		subscribed() ? {} : 'skip'
	);

	// ── Response targets: whether they are on, and the Overdue / Due soon counts
	// beside the tabs, narrowed by the assignment like the tab counts.
	const { data: slaData } = useConvexQuery(
		api.inbox.sla.queries.getListSummary,
		() => {
			if (!subscribed()) return 'skip';
			const assigneeArg = inboxAssigneeArg(assignee.value);
			return assigneeArg ? { assignee: assigneeArg } : {};
		},
		{ keepPreviousData: true }
	);
	watch(slaData, (data) => (slaSummary.value = data ?? null), { immediate: true });

	// ── Actions ──
	const loadMoreThreads = () => {
		const next = frontier.value?.nextCursor;
		if (hasMoreThreads.value && next) tailCursor.value = next;
	};

	return {
		// State
		filter,
		assignee,
		sort,
		setSort,
		toggleSort,
		filterCounts,
		slaSummary,
		isSlaEnabled,
		threads,
		threadsLoading,
		threadsError,
		retryThreads,
		hasMoreThreads,
		stats,
		// Actions
		loadMoreThreads,
	};
}
