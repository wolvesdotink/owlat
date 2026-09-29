import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The live presence ring on the Team Inbox list's assignee avatars.
 *
 * `inbox.queries.listThreads` no longer reads presence: the shell sidebar keeps
 * that list mounted for every admin, so a teammate's heartbeat used to re-run
 * all of them. The ring is only drawn on the Team Inbox page, so the page asks
 * `inbox.presence.presentAssignees` for the rows it shows, and a heartbeat now
 * re-runs just this read.
 *
 * The pairs are sorted so a re-sort of the list keeps the same subscription;
 * previous data is kept while a grown page re-subscribes so rings don't blink.
 */
export function useInboxAssigneePresence(
	threads: Ref<ReadonlyArray<{ _id: string; assignedTo?: string | null }>>
) {
	const rows = computed(() =>
		threads.value
			.filter((thread) => !!thread.assignedTo)
			.map((thread) => ({
				threadId: thread._id as Id<'conversationThreads'>,
				assigneeId: thread.assignedTo as string,
			}))
			.sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0))
	);

	const { data } = useConvexQuery(
		api.inbox.presence.presentAssignees,
		() => (rows.value.length > 0 ? { rows: rows.value } : 'skip'),
		{ keepPreviousData: true }
	);

	const present = computed(() => new Set<string>(rows.value.length > 0 ? (data.value ?? []) : []));

	/** Is this row's assignee on the thread right now? */
	return (threadId: string) => present.value.has(threadId);
}
