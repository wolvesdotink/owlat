/**
 * Current mailbox + accounts list, persisted to localStorage.
 *
 * For P1 we assume one mailbox per user; this composable just picks the
 * first available mailbox by default. P3+ will introduce explicit
 * account switching.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const STORAGE_KEY = 'owlat:postbox:active-mailbox';

export function usePostboxMailbox() {
	const { data, isLoading, error } = useConvexQuery(api.mail.mailbox.list, () => ({}));
	const mailboxes = computed(() => data.value ?? []);

	const persistedId = ref<Id<'mailboxes'> | null>(
		(import.meta.client && (localStorage.getItem(STORAGE_KEY) as Id<'mailboxes'> | null)) || null
	);

	const currentMailbox = computed(() => {
		const list = mailboxes.value;
		if (list.length === 0) return null;
		if (persistedId.value) {
			const match = list.find((m) => m._id === persistedId.value);
			if (match) return match;
		}
		return list[0] ?? null;
	});

	const setCurrentMailbox = (id: Id<'mailboxes'>) => {
		persistedId.value = id;
		if (import.meta.client) {
			localStorage.setItem(STORAGE_KEY, id);
		}
	};

	return {
		mailboxes,
		currentMailbox,
		setCurrentMailbox,
		isLoading,
		error,
	};
}
