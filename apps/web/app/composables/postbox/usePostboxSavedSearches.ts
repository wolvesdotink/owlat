/**
 * Saved searches — per-mailbox named queries, pinned ones in the folder rail.
 *
 * The stored artifact is the raw query STRING, which is also what `?q=` on the
 * search page carries: running a saved search and opening a bookmarked search
 * URL are the same navigation, and a saved search re-parses on every run so it
 * inherits parser fixes instead of freezing the grammar it was saved under.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/** The bookmarkable URL for a raw query — the one place that shape is built. */
export function savedSearchPath(rawQuery: string): string {
	const trimmed = rawQuery.trim();
	return trimmed
		? `/dashboard/postbox/search?q=${encodeURIComponent(trimmed)}`
		: '/dashboard/postbox/search';
}

export function usePostboxSavedSearches(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { data, isLoading } = useConvexQuery(api.mail.savedSearches.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const savedSearches = computed(() => data.value ?? []);
	const pinnedSearches = computed(() => savedSearches.value.filter((row) => row.isPinned));

	const createOp = useBackendOperation(api.mail.savedSearches.create, {
		label: () => t('shared.postbox.usePostboxSavedSearches.saveSearch'),
	});
	const updateOp = useBackendOperation(api.mail.savedSearches.update, {
		label: () => t('shared.postbox.usePostboxSavedSearches.updateSearch'),
	});
	const removeOp = useBackendOperation(api.mail.savedSearches.remove, {
		label: () => t('shared.postbox.usePostboxSavedSearches.deleteSearch'),
	});

	async function save(name: string, rawQuery: string, isPinned = true) {
		if (!mailboxId.value) return { ok: false } as const;
		return createOp.run({ mailboxId: mailboxId.value, name, rawQuery, isPinned });
	}

	async function rename(savedSearchId: Id<'mailSavedSearches'>, name: string) {
		return updateOp.run({ savedSearchId, name });
	}

	async function setPinned(savedSearchId: Id<'mailSavedSearches'>, isPinned: boolean) {
		return updateOp.run({ savedSearchId, isPinned });
	}

	async function remove(savedSearchId: Id<'mailSavedSearches'>) {
		return removeOp.run({ savedSearchId });
	}

	return {
		savedSearches,
		pinnedSearches,
		isLoading,
		isSaving: createOp.isLoading,
		save,
		rename,
		setPinned,
		remove,
	};
}
