/**
 * The mailbox a mail settings page (vacation reply, signatures, forwarding,
 * filters, aliases, app passwords) edits, and the mailboxes it may switch to.
 *
 * Settings hides the Postbox sidebar and its mailbox switcher, so the page
 * names its mailbox itself. A switch here is local to settings: it is held in
 * session state the six pages share, never in the shared Postbox selection, so
 * looking at a team inbox's auto-reply does not change which mailbox the
 * Postbox opens on. It is not held in the URL either: a page's draft belongs to
 * the mailbox it was typed for, and a sidebar link or Back that dropped a query
 * would otherwise move the draft onto another mailbox. A link about one mailbox
 * seeds the choice with `?settingsMailbox=` (see `SETTINGS_MAILBOX_QUERY`); the
 * seed only becomes the stored choice once the page may edit that mailbox, so
 * a link to one the viewer cannot edit does not replace what they chose. The
 * stored choice belongs to the signed-in user: signing out does not reload the
 * app, and the next account must not inherit it.
 * Without a choice the page edits the mailbox open in the Postbox, when the
 * viewer may edit it there.
 *
 * `minRole` is the floor the page's save mutations check: vacation, forwarding,
 * filters, aliases and app passwords need `owner`, signatures only `member`.
 * A mailbox below it is not offered, because every save on it would be refused.
 * A stored choice below the floor is passed over on that page but kept, so the
 * signatures page can stay on a team inbox the other pages cannot edit.
 *
 * `onSwitch` runs when the edited mailbox changes after one was settled, by the
 * picker or underneath it (the roles read drops the mailbox, the Postbox moves
 * in another tab). The page drops its draft there, so nothing typed for one
 * mailbox is saved to another.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { SETTINGS_MAILBOX_QUERY } from '~/utils/postboxSettingsMailbox';

export function usePostboxSettingsMailbox(
	minRole: 'owner' | 'member',
	options: { onSwitch?: () => void } = {}
) {
	const {
		mailboxes: all,
		currentMailbox: openMailbox,
		isLoading: listLoading,
		error: listError,
		refetch: refetchList,
	} = usePostboxMailbox();
	const {
		data: roles,
		error: rolesError,
		refetch: refetchRoles,
	} = useConvexQuery(api.mail.mailboxMembers.myRoles, () => ({}));

	const mailboxes = computed(() => {
		if (!roles.value) return [];
		const allowed = new Set(
			roles.value
				.filter((row) => minRole === 'member' || row.role === 'owner')
				.map((row) => row.mailboxId)
		);
		return all.value.filter((m) => allowed.has(m._id));
	});

	const { user } = useAuth();
	const stored = useState<{ userId: string; mailboxId: Id<'mailboxes'> } | null>(
		'settings-mailbox',
		() => null
	);
	const chosen = computed(() =>
		stored.value && stored.value.userId === user.value?.id ? stored.value.mailboxId : null
	);
	function choose(id: Id<'mailboxes'>) {
		const userId = user.value?.id;
		if (userId) stored.value = { userId, mailboxId: id };
	}

	// Read once, at setup, before a page's deep-link cleanup clears the query.
	const seedQuery = useRoute().query[SETTINGS_MAILBOX_QUERY];
	const seed = ref<Id<'mailboxes'> | null>(
		typeof seedQuery === 'string' && seedQuery ? (seedQuery as Id<'mailboxes'>) : null
	);

	const currentMailbox = computed(() => {
		const list = mailboxes.value;
		const open = openMailbox.value?._id;
		return (
			(seed.value ? list.find((m) => m._id === seed.value) : undefined) ??
			list.find((m) => m._id === chosen.value) ??
			list.find((m) => m._id === open) ??
			list[0] ??
			null
		);
	});
	const mailboxId = computed(() => currentMailbox.value?._id ?? null);

	// A blip to null (a read re-subscribing) is not a switch; the next mailbox
	// is compared with the last one the page actually edited.
	let settled: Id<'mailboxes'> | null = null;
	watch(
		mailboxId,
		(next) => {
			if (!next) return;
			if (settled && settled !== next) options.onSwitch?.();
			settled = next;
		},
		{ immediate: true }
	);

	const error = computed(() => listError.value ?? rolesError.value ?? null);
	const isLoading = computed(
		() => listLoading.value || (roles.value === undefined && !rolesError.value)
	);

	// Once both reads have succeeded, an editable seed becomes the choice and
	// any other seed is dropped. A failed read says nothing about eligibility,
	// so the seed waits for the retry.
	watch(
		[isLoading, error],
		([loading, failed]) => {
			const id = seed.value;
			if (loading || failed || !id) return;
			if (mailboxes.value.some((m) => m._id === id)) choose(id);
			seed.value = null;
		},
		{ immediate: true }
	);

	function selectMailbox(id: Id<'mailboxes'>) {
		seed.value = null;
		choose(id);
	}

	function refetch() {
		refetchList();
		refetchRoles();
	}

	return { mailboxes, currentMailbox, mailboxId, selectMailbox, isLoading, error, refetch };
}
