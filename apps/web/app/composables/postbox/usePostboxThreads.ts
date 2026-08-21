/**
 * Paginated thread/message list per folder.
 *
 * Keyset-paginated via usePostboxCursorFeed: the first page stays a live
 * subscription (new mail floats in), "Load more" appends one cursor-keyed page
 * at a time instead of re-subscribing with a growable limit.
 *
 * P1 simplification note: returns mailMessages directly. P3 will add a proper
 * thread aggregate query backed by mailThreads.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxThreads(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	// Custom (non-role) folder addressed by id; takes precedence over folderRole.
	folderId?: Ref<Id<'mailFolders'> | undefined>;
}) {
	const resetKey = computed(() => args.folderId?.value ?? args.folderRole.value);

	const { rows, isLoading, isRefetching, hasMore, loadMore } = usePostboxCursorFeed(
		api.mail.mailbox.listMessages,
		() => {
			if (!args.mailboxId.value) return 'skip';
			const folderId = args.folderId?.value;
			return folderId
				? { mailboxId: args.mailboxId.value, folderId, limit: 50 }
				: { mailboxId: args.mailboxId.value, folderRole: args.folderRole.value, limit: 50 };
		},
		resetKey,
		// Keep the prior folder's rows visible while the next folder loads, so
		// switching folders never flashes a blank full-pane spinner.
		{ keepPreviousData: true }
	);

	return {
		messages: rows,
		isLoading,
		isRefetching,
		hasMore,
		loadMore,
	};
}

/**
 * Ultra-compact timestamp for thread/message lists ("5m", "3h", "2d", no
 * "ago" suffix). Distinct from the app-wide formatCompactRelativeTime ("5m
 * ago") and formatRelativeTime ("5 minutes ago") in utils/formatters.ts — the
 * distinct name avoids the Nuxt auto-import collision that previously let this
 * shadow the canonical formatter globally.
 */
export function formatThreadTimestamp(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);

	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 7) return `${days}d`;
	return new Date(timestamp).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
	});
}
