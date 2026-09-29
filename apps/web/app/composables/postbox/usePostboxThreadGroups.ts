/**
 * Conversation-grouped list (one row per thread) for the inbox view, backed by
 * mail.mailbox.queries.listThreads. Mirrors usePostboxThreads' growable-limit paging.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxThreadGroups(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	enabled: Ref<boolean>;
	/**
	 * What resets the growable limit (and so which view's paging this is).
	 * Defaults to the folder; the Categories view passes its own key so it
	 * pages independently of the conversation view on the same feed.
	 */
	limitKey?: Ref<string>;
}) {
	const { limit, loadMore, atMax } = useGrowableLimit(args.limitKey ?? args.folderRole);

	const { data, isLoading, isRefetching } = useConvexQuery(
		api.mail.mailbox.queries.listThreads,
		() =>
			args.enabled.value && args.mailboxId.value
				? {
						mailboxId: args.mailboxId.value,
						folderRole: args.folderRole.value,
						limit: limit.value,
					}
				: 'skip',
		{ keepPreviousData: true }
	);

	const threads = computed(() => data.value?.threads ?? []);
	const hasMore = computed(() => (data.value?.hasMore ?? false) && !atMax.value);

	return { threads, isLoading, isRefetching, hasMore, loadMore };
}
