/**
 * Current mailbox + accounts list, with the active selection shared across the
 * whole Postbox surface.
 *
 * A user reaches their own personal mailbox(es) plus any shared (team) inbox
 * they belong to (LOCKED decision 7 of the 2026-07-10 experience plan). The
 * active selection is held in shared `useState` (seeded from localStorage) so
 * switching mailboxes in the sidebar switcher reactively re-renders the layout
 * everywhere — every consumer reads the same selection, and it survives reload.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { derivePostboxSidebarSections } from '~/utils/postboxMailboxSections';

const STORAGE_KEY = 'owlat:postbox:active-mailbox';

export function usePostboxMailbox() {
	const { data, isLoading, error } = useConvexQuery(api.mail.mailbox.list, () => ({}));
	const mailboxes = computed(() => data.value ?? []);

	// Shared across every consumer so a switch in the sidebar reaches the page,
	// reader, and composer at once. Seeded once from localStorage on the client.
	const persistedId = useState<Id<'mailboxes'> | null>('postbox:active-mailbox', () =>
		import.meta.client ? (localStorage.getItem(STORAGE_KEY) as Id<'mailboxes'> | null) : null
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

	// Switch to a mailbox and land on its inbox rather than a folder/message id
	// that only exists in the previous mailbox. Shared by the sidebar switcher and
	// the Cmd-K palette so the switch behaviour lives in one place.
	const switchToMailbox = (id: Id<'mailboxes'>) => {
		setCurrentMailbox(id);
		void navigateTo('/dashboard/postbox/inbox');
	};

	// The caller's accessible+active mailboxes (own + explicit shared memberships),
	// each with its label, scope, and inbox unread. This — NOT `list`, which
	// returns every org mailbox for owners/admins — drives the sidebar switcher and
	// Cmd-K entries, so an admin never sees a teammate's private inbox or a shared
	// inbox they don't belong to advertised as a switch target, and the badges
	// always match the listed mailboxes.
	const { data: accessibleData } = useConvexQuery(api.mail.mailbox.accessible, () => ({}));
	const accessible = computed(() => accessibleData.value ?? []);

	// Personal mailbox(es) vs shared (team) inboxes, for the sidebar switcher.
	const sections = computed(() => derivePostboxSidebarSections(accessible.value));

	return {
		mailboxes,
		sections,
		currentMailbox,
		setCurrentMailbox,
		switchToMailbox,
		isLoading,
		error,
	};
}
