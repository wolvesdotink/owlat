/**
 * The Files view's data: a faceted, cursor-paginated walk over one mailbox's
 * attachment index (`mail/mailbox/attachments.list`).
 *
 * Facet state lives here rather than in the panel so the panel stays a
 * renderer: the composable owns the four narrowings (filename query, sender,
 * kind set, date preset), turns them into query args, and resets the paging
 * cursor whenever any of them changes — a stale tail under a new facet would
 * show files that no longer match.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	fileDateAfterMs,
	hasActiveFileFacets,
	toggleFileKind,
	type PostboxFileDateRange,
	type PostboxFileKind,
} from '~/utils/postboxFileFacets';

export function usePostboxFiles(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const query = ref('');
	const fromAddress = ref<string | null>(null);
	const kinds = ref<PostboxFileKind[]>([]);
	const dateRange = ref<PostboxFileDateRange>('all');

	// Pinned once per facet change rather than read live, so a list does not
	// silently re-narrow under the user while they scroll a long "last week".
	const nowAnchor = ref(Date.now());

	const facetKey = computed(() =>
		JSON.stringify([query.value.trim(), fromAddress.value, kinds.value, dateRange.value])
	);

	watch(facetKey, () => {
		nowAnchor.value = Date.now();
	});

	const args = computed(() => {
		if (!mailboxId.value) return 'skip' as const;
		const afterMs = fileDateAfterMs(dateRange.value, nowAnchor.value);
		const trimmed = query.value.trim();
		return {
			mailboxId: mailboxId.value,
			...(trimmed ? { filenameQuery: trimmed } : {}),
			...(fromAddress.value ? { fromAddress: fromAddress.value } : {}),
			...(kinds.value.length > 0 ? { kinds: kinds.value } : {}),
			...(afterMs !== undefined ? { afterMs } : {}),
		};
	});

	const feed = usePostboxCursorFeed(api.mail.mailbox.attachments.list, () => args.value, facetKey, {
		rowsKey: 'files',
		hardResetKey: mailboxId,
	});

	const { data: facetData } = useConvexQuery(api.mail.mailbox.attachments.senderFacets, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const senderFacets = computed(() => facetData.value ?? []);

	const isFiltered = computed(() =>
		hasActiveFileFacets({
			kinds: kinds.value,
			dateRange: dateRange.value,
			fromAddress: fromAddress.value,
			query: query.value,
		})
	);

	function toggleKind(kind: PostboxFileKind) {
		kinds.value = toggleFileKind(kinds.value, kind);
	}

	function clearFacets() {
		query.value = '';
		fromAddress.value = null;
		kinds.value = [];
		dateRange.value = 'all';
	}

	return {
		files: feed.rows,
		isLoading: feed.isLoading,
		isLoadingMore: feed.isLoadingMore,
		canLoadMore: feed.canLoadMore,
		loadMore: feed.loadMore,
		senderFacets,
		query,
		fromAddress,
		kinds,
		dateRange,
		isFiltered,
		toggleKind,
		clearFacets,
	};
}
