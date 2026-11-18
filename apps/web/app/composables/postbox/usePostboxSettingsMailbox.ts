/**
 * The mailbox a mail settings page (vacation reply, signatures, forwarding,
 * filters, aliases, app passwords) edits, and the mailboxes it may switch to.
 *
 * Settings hides the Postbox sidebar and its mailbox switcher, so the page
 * names its mailbox itself. A switch here is local to settings: it is held in
 * `?settingsMailbox=`, never in the shared Postbox selection, so looking at a
 * team inbox's auto-reply does not change which mailbox the Postbox opens on.
 * The key must not be `mailbox`: `usePostboxMailbox` writes that one into the
 * shared selection. Without the query the page edits the mailbox open in the
 * Postbox, when the viewer may edit it there.
 *
 * `minRole` is the floor the page's save mutations check: vacation, forwarding,
 * filters, aliases and app passwords need `owner`, signatures only `member`.
 * A mailbox below it is not offered, because every save on it would be refused.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export const SETTINGS_MAILBOX_QUERY = 'settingsMailbox';

export function usePostboxSettingsMailbox(minRole: 'owner' | 'member') {
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

	const route = useRoute();
	const currentMailbox = computed(() => {
		const list = mailboxes.value;
		const requested = route.query[SETTINGS_MAILBOX_QUERY];
		const open = openMailbox.value?._id;
		return (
			list.find((m) => m._id === requested) ?? list.find((m) => m._id === open) ?? list[0] ?? null
		);
	});
	const mailboxId = computed(() => currentMailbox.value?._id ?? null);

	const error = computed(() => listError.value ?? rolesError.value ?? null);
	const isLoading = computed(
		() => listLoading.value || (roles.value === undefined && !rolesError.value)
	);

	function selectMailbox(id: Id<'mailboxes'>) {
		void navigateTo(
			{ query: { ...route.query, [SETTINGS_MAILBOX_QUERY]: id }, hash: route.hash },
			{ replace: true }
		);
	}

	function refetch() {
		refetchList();
		refetchRoles();
	}

	return { mailboxes, currentMailbox, mailboxId, selectMailbox, isLoading, error, refetch };
}
