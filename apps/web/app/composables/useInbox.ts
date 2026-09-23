import { api } from '@owlat/api';
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
	const sort = computed<InboxSort>(() => resolveInboxSort(storedSort.value));
	const setSort = (next: InboxSort) => {
		setStoredSort(next);
	};
	const toggleSort = () => {
		setSort(nextInboxSort(sort.value));
	};
	// `?filter=waiting-24h` used to be a tab; it now means "Open, longest wait first".
	const impliedSort = legacyInboxSort(route.query['filter']);
	if (impliedSort) setSort(impliedSort);

	// ── Thread list (keyset pagination; the args pick the backend index) ──
	const threadCursor = ref<string | undefined>(undefined);
	const {
		data: threadsData,
		isLoading: threadsLoading,
		error: threadsError,
	} = useConvexQuery(api.inbox.queries.listThreads, () => {
		if (!subscribed()) return 'skip';
		const assigneeArg = inboxAssigneeArg(assignee.value);
		return {
			filter: filter.value,
			...(assigneeArg ? { assignee: assigneeArg } : {}),
			sort: sort.value,
			limit: 25,
			cursor: threadCursor.value,
		};
	});

	type Thread = NonNullable<typeof threadsData.value>['threads'][number];

	// Accumulate pages: the first page (cursor undefined) replaces; each
	// subsequent page appends (deduped by _id). Mirrors useActivityTimeline.
	const accumulatedThreads = ref<Thread[]>([]);
	watch(
		threadsData,
		(data) => {
			if (!data) return;
			if (!threadCursor.value) {
				accumulatedThreads.value = [...data.threads];
			} else {
				const seen = new Set(accumulatedThreads.value.map((t) => t._id));
				accumulatedThreads.value = [
					...accumulatedThreads.value,
					...data.threads.filter((t) => !seen.has(t._id)),
				];
			}
		},
		{ immediate: true }
	);

	// A filter OR sort change selects a different backend index/order, so a
	// keyset cursor minted for the prior view is invalid. Reset to a fresh first
	// page synchronously — before the query re-subscribes.
	watch(
		[filter, assignee, sort],
		() => {
			threadCursor.value = undefined;
			accumulatedThreads.value = [];
		},
		{ flush: 'sync' }
	);

	const threads = computed(() => accumulatedThreads.value);
	const hasMoreThreads = computed(() => !!threadsData.value?.nextCursor);

	// ── Filter-pill counts (bounded reads; a slice at the cap renders "99+") ──
	const { data: filterCounts } = useConvexQuery(api.inbox.queries.getThreadFilterCounts, () => {
		if (!subscribed()) return 'skip';
		const assigneeArg = inboxAssigneeArg(assignee.value);
		return assigneeArg ? { assignee: assigneeArg } : {};
	});

	// Review-queue badge count (drafts ready) — a real pipeline counter, retained
	// even though the old 8-cell stats grid is gone.
	const { data: stats } = useConvexQuery(api.inbox.queries.getInboundStats, () =>
		subscribed() ? {} : 'skip'
	);

	// ── Actions ──
	const loadMoreThreads = () => {
		if (threadsData.value?.nextCursor) {
			threadCursor.value = threadsData.value.nextCursor;
		}
	};

	return {
		// State
		filter,
		assignee,
		sort,
		setSort,
		toggleSort,
		filterCounts,
		threads,
		threadsLoading,
		threadsError,
		hasMoreThreads,
		stats,
		// Actions
		loadMoreThreads,
	};
}
