/**
 * Conversation-grouped list (one row per thread) for the inbox view, backed by
 * mail.mailbox.listThreads. Mirrors usePostboxThreads' growable-limit paging.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxThreadGroups(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	enabled: Ref<boolean>;
}) {
	const { limit, loadMore, atMax } = useGrowableLimit(args.folderRole);

	const { data, isLoading, isRefetching } = useConvexQuery(
		api.mail.mailbox.listThreads,
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
