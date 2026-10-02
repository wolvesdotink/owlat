import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The note chip on Team Inbox rows: how many internal notes each shown thread
 * has. Asked for the visible rows only, the way the presence ring is
 * (`useInboxAssigneePresence`), so a teammate writing a note re-runs this read
 * and not every admin's thread list. Ids are sorted so a re-sort of the list
 * keeps the same subscription, and previous counts stay while a grown page
 * re-subscribes so chips don't blink.
 */
export function useInboxNoteCounts(threads: Ref<ReadonlyArray<{ _id: string }>>) {
	const threadIds = computed(() =>
		threads.value.map((thread) => thread._id as Id<'conversationThreads'>).sort()
	);

	const { data } = useConvexQuery(
		api.inbox.notes.countsForThreads,
		() => (threadIds.value.length > 0 ? { threadIds: threadIds.value } : 'skip'),
		{ keepPreviousData: true }
	);

	const counts = computed(
		() => new Map<string, number>((data.value ?? []).map((row) => [row.threadId, row.count]))
	);

	/** Notes on this thread (0 when none). */
	return (threadId: string) => counts.value.get(threadId) ?? 0;
}
