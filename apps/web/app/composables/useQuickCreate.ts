import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * The app's CREATE verbs, in one place, so every surface that offers "compose"
 * or "new contact" runs the same thing.
 *
 * The command palette used to fake both: "Compose" navigated to the inbox LIST
 * and "New contact" to the contacts LIST, so a palette that promised to create
 * something just moved you somewhere and left you to find the button. The real
 * mechanisms already existed — `PostboxComposeButton` opens the composer stack,
 * and the contacts page opens its Add dialog for `?action=add` — they were just
 * not reachable from anywhere else. This is that shared entry point (the "one
 * quick-create registry" T6 will hang the header split-button off).
 *
 * Composers only RENDER inside the Postbox (`PostboxComposerStack` is mounted
 * there), so composing from another surface navigates first and then opens —
 * the stack is shared `useState`, so the composer is already in it by the time
 * the Postbox paints.
 */

/** Where the composer lives when the caller is not already in the Postbox. */
const POSTBOX_COMPOSE_ROUTE = '/dashboard/postbox/inbox';

/** The contacts list, told to open its Add dialog on arrival. */
const NEW_CONTACT_ROUTE = {
	path: '/dashboard/audience/contacts',
	query: { action: 'add' },
} as const;

/** True while `path` is the Postbox surface (or one of its children). */
function isPostboxPath(path: string): boolean {
	return path === '/dashboard/postbox' || path.startsWith('/dashboard/postbox/');
}

export function useQuickCreate() {
	const route = useRoute();
	const stack = usePostboxComposerStack();
	const { activeMailboxId, setActiveMailboxId } = usePostboxActiveMailbox();

	/**
	 * The mailbox a new composer belongs to: the shared Postbox selection when
	 * there is one, else the same first mailbox `usePostboxMailbox` would fall
	 * back to — read ONCE through the client rather than through
	 * `useConvexQuery`, because this runs on every dashboard surface and must not
	 * leave a live Postbox subscription behind on the billing screen. The
	 * resolved mailbox is persisted, so the Postbox we land on shows the mailbox
	 * the composer is addressing.
	 */
	async function resolveComposeMailboxId(): Promise<Id<'mailboxes'> | null> {
		if (activeMailboxId.value) return activeMailboxId.value;
		try {
			const mailboxes = await requireConvex().query(api.mail.mailbox.identity.list, {});
			const first = mailboxes[0]?._id ?? null;
			if (first) setActiveMailboxId(first);
			return first;
		} catch {
			// No client yet (or the query failed): fall through to the Postbox,
			// which owns the honest "no mailbox" / error state.
			return null;
		}
	}

	/**
	 * Open a real composer. Off the Postbox this lands there first; with no
	 * mailbox at all it still lands there, where `PostboxMailboxGuard` explains
	 * why there is nothing to compose from instead of a silently dead keystroke.
	 */
	async function openCompose(): Promise<void> {
		const mailboxId = await resolveComposeMailboxId();
		if (!isPostboxPath(route.path)) await navigateTo(POSTBOX_COMPOSE_ROUTE);
		if (!mailboxId) return;
		stack.open({ mailboxId });
	}

	/** Open the contacts list with its Add contact dialog already up. */
	async function openNewContact(): Promise<void> {
		await navigateTo(NEW_CONTACT_ROUTE);
	}

	return { openCompose, openNewContact };
}
