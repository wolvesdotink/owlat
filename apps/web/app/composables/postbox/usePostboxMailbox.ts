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
import { seedPostboxMailboxId } from '~/utils/postboxMailboxSeed';

export function usePostboxMailbox() {
	const { data, isLoading, error } = useConvexQuery(api.mail.mailbox.identity.list, () => ({}));
	const mailboxes = computed(() => data.value ?? []);

	// Shared across every consumer so a switch in the sidebar reaches the page,
	// reader, and composer at once — including the app-wide command palette,
	// which owns the selection through `usePostboxActiveMailbox` alone (no
	// Postbox subscriptions on non-Postbox screens).
	const { activeMailboxId: persistedId, setActiveMailboxId } = usePostboxActiveMailbox();

	const currentMailbox = computed(() => {
		const list = mailboxes.value;
		if (list.length === 0) return null;
		if (persistedId.value) {
			const match = list.find((m) => m._id === persistedId.value);
			if (match) return match;
		}
		return list[0] ?? null;
	});

	const setCurrentMailbox = setActiveMailboxId;

	// Deep links from outside the Postbox (the sidebar's inbox groups, Today,
	// the Answer queue) name the inbox a thread lives in with `?mailbox=`, so a
	// row from Support opens in Support even when the last-used inbox differs.
	// Only a mailbox the caller can actually read is honoured.
	const route = useRoute();
	watch(
		[() => route.query['mailbox'], mailboxes],
		([requested, list]) => {
			if (typeof requested !== 'string' || requested === persistedId.value) return;
			if (list.some((m) => m._id === requested)) setActiveMailboxId(requested as Id<'mailboxes'>);
		},
		{ immediate: true }
	);

	// Switch to a mailbox and land on its inbox rather than a folder/message id
	// that only exists in the previous mailbox. Shared by the sidebar switcher and
	// the Cmd-K palette so the switch behaviour lives in one place.
	const switchToMailbox = (id: Id<'mailboxes'>) => {
		setCurrentMailbox(id);
		void navigateTo('/dashboard/postbox/inbox');
	};

	// The caller's accessible+active mailboxes (own + explicit shared memberships),
	// each with its label, scope, and inbox unread. `list` is the same set as full
	// mailbox docs (suspended rows included), so `currentMailbox` above can only
	// fall back to one of these; this projection drives the sidebar switcher and
	// Cmd-K entries, so the badges always match the listed mailboxes.
	const { data: accessibleData } = useConvexQuery(api.mail.mailbox.queries.accessible, () => ({}));
	const accessible = computed(() => accessibleData.value ?? []);

	// The id the Postbox renders with (plan 2.5): the current mailbox once
	// `list` has loaded, and before that a seed verified against the
	// shell-warm `accessible` rows, so the page starts its list and message
	// queries without waiting for `list`. See utils/postboxMailboxSeed.
	const mailboxId = computed<Id<'mailboxes'> | null>(() => {
		if (currentMailbox.value) return currentMailbox.value._id;
		if (!isLoading.value) return null;
		const requested = route.query['mailbox'];
		return seedPostboxMailboxId({
			requested: typeof requested === 'string' ? requested : null,
			persisted: persistedId.value,
			accessible: accessibleData.value,
		}) as Id<'mailboxes'> | null;
	});

	// Personal mailbox(es) vs shared (team) inboxes, for the sidebar switcher.
	const sections = computed(() => derivePostboxSidebarSections(accessible.value));

	return {
		mailboxes,
		sections,
		currentMailbox,
		mailboxId,
		setCurrentMailbox,
		switchToMailbox,
		isLoading,
		error,
	};
}
