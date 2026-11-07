/**
 * The list of All inboxes or a unified folder: that system folder of every
 * readable mailbox merged newest first (`mail.mailbox.allInboxes.listMessages`),
 * paged through the same keyset cursor feed as one folder, so the first page
 * stays live and "Load more" appends. All Drafts reads drafts instead
 * (`listDrafts` in PostboxDraftList), so this feed skips for it.
 *
 * The sources come from `mail.mailbox.queries.accessible` (the subscription
 * the shell already holds), which names each mailbox's folder of every role.
 * The server still checks every source against the caller's own mailboxes and
 * team-inbox memberships; the list here only decides which of them to ask for.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	allInboxesSources,
	mailboxProviders,
	matchesNarrow,
	type UnifiedFolderRole,
} from '~/utils/postboxAllInboxes';

export function usePostboxAllInboxesFeed(args: {
	role: Ref<UnifiedFolderRole>;
	/** One mailbox to narrow to (`?in=`), or null. Wins over `provider`. */
	only: Ref<Id<'mailboxes'> | null>;
	/** The `?provider=` the route asks for, or null. */
	provider: Ref<string | null>;
}) {
	const { data: accessible, isLoading: accessibleLoading } = useConvexQuery(
		api.mail.mailbox.queries.accessible,
		() => ({})
	);
	/** The providers the viewer's mailboxes span, for the narrow control. */
	const providers = computed(() => mailboxProviders(accessible.value ?? []));
	// A provider none of the viewer's mailboxes is on narrows nothing, and a
	// mailbox narrow wins over a provider one.
	const provider = computed(() => {
		const asked = args.provider.value;
		if (args.only.value || !asked) return null;
		return providers.value.some((entry) => entry.key === asked) ? asked : null;
	});
	const narrow = computed(() => ({ only: args.only.value, provider: provider.value }));
	const sources = computed(() =>
		args.role.value === 'drafts'
			? []
			: allInboxesSources(accessible.value ?? [], args.role.value, narrow.value)
	);
	/** The mailboxes the narrow keeps, for the drafts list. */
	const mailboxIds = computed(() =>
		(accessible.value ?? [])
			.filter((row) => matchesNarrow(row, narrow.value))
			.map((row) => row.mailboxId)
	);
	/** Unread Inbox mail of the mailboxes the narrow keeps. */
	const inboxUnread = computed(() =>
		(accessible.value ?? [])
			.filter((row) => matchesNarrow(row, narrow.value))
			.reduce((sum, row) => sum + row.unread, 0)
	);
	// A different set of inboxes is a different list: no cursor carries over.
	const resetKey = computed(() => sources.value.map((source) => source.folderId).join(','));

	const feed = usePostboxCursorFeed(
		api.mail.mailbox.allInboxes.listMessages,
		() => (sources.value.length > 0 ? { sources: sources.value, limit: 50 } : 'skip'),
		resetKey,
		{ keepPreviousData: true }
	);

	return {
		providers,
		/** The provider narrow in effect, or null. */
		provider,
		mailboxIds,
		/** Each listed mailbox's folder of the role, which the list reads from. */
		sources,
		inboxUnread,
		messages: feed.rows,
		isLoading: computed(
			() => (accessibleLoading.value && !accessible.value) || feed.isLoading.value
		),
		isLoadingMore: feed.isLoadingMore,
		hasMore: feed.hasMore,
		canLoadMore: feed.canLoadMore,
		loadMore: feed.loadMore,
		/** The first page failed: a failed read, not an empty list. */
		error: feed.firstPageError,
		refetch: feed.refetch,
	};
}
