/**
 * The active Postbox mailbox selection, on its own.
 *
 * Split out of `usePostboxMailbox` because that composable opens two Convex
 * subscriptions (the mailbox list and the accessible list) the moment it is
 * called. The app-wide command palette is mounted on EVERY dashboard page and
 * only needs to point the selection at another mailbox before navigating to a
 * message that lives there — paying for two Postbox subscriptions on the
 * billing screen to do that would be absurd.
 *
 * The state is the same shared `useState` key seeded from the same localStorage
 * key, so both composables read and write one selection.
 */

import type { Id } from '@owlat/api/dataModel';

const STORAGE_KEY = 'owlat:postbox:active-mailbox';

export function usePostboxActiveMailbox() {
	// Shared across every consumer so a switch in the sidebar reaches the page,
	// reader, and composer at once. Seeded once from localStorage on the client.
	const activeMailboxId = useState<Id<'mailboxes'> | null>('postbox:active-mailbox', () =>
		import.meta.client ? (localStorage.getItem(STORAGE_KEY) as Id<'mailboxes'> | null) : null
	);

	function setActiveMailboxId(id: Id<'mailboxes'>) {
		activeMailboxId.value = id;
		if (import.meta.client) {
			localStorage.setItem(STORAGE_KEY, id);
		}
	}

	return { activeMailboxId, setActiveMailboxId };
}
