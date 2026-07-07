import { api } from '@owlat/api';

export type ThreadStatus = 'open' | 'waiting' | 'resolved' | 'closed';

export function useInbox() {
	// Filter state
	const statusFilter = ref<ThreadStatus | undefined>(undefined);
	const assignedToMe = ref(false);
	const threadCursor = ref<string | undefined>(undefined);

	// Fetch threads (keyset pagination — the args choose the backend index).
	const { data: threadsData, isLoading: threadsLoading } = useConvexQuery(
		api.inbox.queries.listThreads,
		() => ({
			status: statusFilter.value,
			assignedToMe: assignedToMe.value || undefined,
			limit: 25,
			cursor: threadCursor.value,
		})
	);

	type Thread = NonNullable<typeof threadsData.value>['threads'][number];

	// Accumulate pages instead of replacing the visible list on each cursor
	// advance: the first page (cursor undefined) replaces; each subsequent page
	// appends (deduped by _id). Mirrors useActivityTimeline.
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

	// A filter change selects a DIFFERENT backend index (by_assigned_to /
	// by_status / by_last_message_at), so a keyset cursor minted for the prior
	// index is invalid. Reset to a fresh first page synchronously — before the
	// query re-subscribes — whenever a filter changes.
	watch(
		[statusFilter, assignedToMe],
		() => {
			threadCursor.value = undefined;
			accumulatedThreads.value = [];
		},
		{ flush: 'sync' }
	);

	const threads = computed(() => accumulatedThreads.value);
	const hasMoreThreads = computed(() => !!threadsData.value?.nextCursor);

	// Stats
	const { data: stats, isLoading: statsLoading } = useConvexQuery(
		api.inbox.queries.getInboundStats,
		() => ({})
	);

	// Load more
	const loadMoreThreads = () => {
		if (threadsData.value?.nextCursor) {
			threadCursor.value = threadsData.value.nextCursor;
		}
	};

	// Reset filters
	const resetFilters = () => {
		statusFilter.value = undefined;
		assignedToMe.value = false;
		threadCursor.value = undefined;
		accumulatedThreads.value = [];
	};

	// Status is rendered by the shared `<InboxStatusChip>` / `threadStatusChip`
	// vocabulary — no per-composable colour/icon helpers (single source of truth).

	// Compact relative time ("Just now", "5m ago", "3h ago", short date past 7d).
	const formatRelativeTime = (timestamp: number) => formatCompactRelativeTime(timestamp);

	return {
		// State
		statusFilter,
		assignedToMe,
		threads,
		threadsLoading,
		hasMoreThreads,
		stats,
		statsLoading,
		// Actions
		loadMoreThreads,
		resetFilters,
		// Helpers
		formatRelativeTime,
	};
}
