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
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { POSTBOX_SORT_ORDER_DEFAULT, postboxSortOrderArg } from '~/utils/postboxSortOrder';
import { usePostboxRoleFolderId } from './usePostboxRoleFolderId';

export function usePostboxThreads(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	// Custom (non-role) folder addressed by id; takes precedence over folderRole.
	// A role folder's id is resolved here from `listFolders`.
	folderId?: Ref<Id<'mailFolders'> | undefined>;
	// Arrival direction (newest / oldest). Absent means newest — the order the
	// list had before the control existed.
	sortOrder?: Ref<PostboxSortOrder>;
}) {
	const sortOrder = computed(() => args.sortOrder?.value ?? POSTBOX_SORT_ORDER_DEFAULT);
	// A system folder is addressed by id too once `listFolders` has it: the
	// by-role read makes the server read the folder document, which every
	// delivery and flag change patches, so page 1 would re-run on any mark-read.
	const roleFolderId = usePostboxRoleFolderId({
		mailboxId: args.mailboxId,
		folderRole: args.folderRole,
	});
	const folderId = computed(() => args.folderId?.value ?? roleFolderId.value);
	// Folder switch OR sort flip: drop the accumulated tail, keep the previous
	// rows on screen until the new first page lands. A cursor is minted for one
	// index direction, so flipping the order invalidates every one of them.
	const resetKey = computed(() => `${folderId.value ?? args.folderRole.value}:${sortOrder.value}`);
	// Mailbox switch: additionally suppress the retained page — rows from
	// account A must never render under account B, however briefly.
	const hardResetKey = computed(() => args.mailboxId.value);

	const { rows, isLoading, isLoadingMore, isRefetching, hasMore, canLoadMore, loadMore } =
		usePostboxCursorFeed(
			api.mail.mailbox.queries.listMessages,
			() => {
				if (!args.mailboxId.value) return 'skip';
				// The default order is sent as nothing at all, so a user who never
				// touches the control keeps the exact query shape (and cursors) the
				// list had before it existed.
				const order = postboxSortOrderArg(sortOrder.value);
				const sort = order ? { sortOrder: order } : {};
				return folderId.value
					? { mailboxId: args.mailboxId.value, folderId: folderId.value, limit: 50, ...sort }
					: {
							mailboxId: args.mailboxId.value,
							folderRole: args.folderRole.value,
							limit: 50,
							...sort,
						};
			},
			resetKey,
			// Keep the prior folder's rows visible while the next folder loads, so
			// switching folders never flashes a blank full-pane spinner.
			{ keepPreviousData: true, hardResetKey }
		);

	return {
		messages: rows,
		isLoading,
		isLoadingMore,
		isRefetching,
		hasMore,
		canLoadMore,
		loadMore,
	};
}
