import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export interface ConversationRef {
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
}

/**
 * What the company panel beside a conversation shows: the companies in it
 * (`companies.forThread`) and the tasks taken from it (`tasks.forThread`).
 *
 * The panel and its host both call this; identical queries share one
 * subscription, so the host can lay itself out by the answer without a second
 * read.
 */
export function useConversationContext(ref: () => ConversationRef) {
	const args = () => {
		const { mailThreadId, conversationThreadId } = ref();
		if (mailThreadId) return { mailThreadId };
		if (conversationThreadId) return { conversationThreadId };
		return 'skip' as const;
	};
	const companiesQuery = useConvexQuery(api.companies.companies.forThread, args);
	const tasksQuery = useConvexQuery(api.tasks.tasks.forThread, args);

	const companies = computed(() => companiesQuery.data.value ?? []);
	const tasks = computed(() => tasksQuery.data.value ?? []);
	const isLoading = computed(
		() => companiesQuery.data.value === undefined || tasksQuery.data.value === undefined
	);
	const hasError = computed(() => !!companiesQuery.error.value || !!tasksQuery.error.value);
	/** Whether there is anything beyond "Make task" to show. */
	const hasContext = computed(() => companies.value.length > 0 || tasks.value.length > 0);

	function refetch() {
		if (companiesQuery.error.value) companiesQuery.refetch();
		if (tasksQuery.error.value) tasksQuery.refetch();
	}

	return { companies, tasks, isLoading, hasError, hasContext, refetch };
}
