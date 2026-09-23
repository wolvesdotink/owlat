import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { composeContextForPath } from '~/lib/composeContext';

/**
 * The app's CREATE verbs, in one place, so every surface that offers "compose"
 * or "new contact" runs the same thing.
 *
 * The command palette used to fake both: "Compose" navigated to the inbox LIST
 * and "New contact" to the contacts LIST, so a palette that promised to create
 * something just moved you somewhere and left you to find the button. The real
 * mechanisms already existed — the Postbox composer stack, and the contacts
 * page's Add dialog for `?action=add` — they were just
 * not reachable from anywhere else. This is that shared entry point (the "one
 * quick-create registry" T6 will hang the header split-button off).
 *
 * The composer is an OVERLAY on the page you are on: the shell mounts the same
 * floating composer stack the Postbox uses (`ShellComposerOverlay`), so
 * composing from Today, a campaign or a contact never navigates away. The stack
 * is shared `useState`, so whichever host is mounted renders the new composer.
 * On a contact page the composer is addressed to that contact.
 */

/**
 * Where Compose lands when there is no mailbox to compose from: the Postbox's
 * mailbox guard explains why, instead of a silently dead button.
 */
const POSTBOX_COMPOSE_ROUTE = '/dashboard/postbox/inbox';

/** The contacts list, told to open its Add dialog on arrival. */
const NEW_CONTACT_ROUTE = {
	path: '/dashboard/audience/contacts',
	query: { action: 'add' },
} as const;

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
	 * The recipients the current page implies: the contact's address on a
	 * contact page. Read once through the client (no live subscription), and
	 * best-effort — a contact that cannot be read just means an empty To field.
	 */
	async function resolvePrefillTo(): Promise<string[]> {
		const context = composeContextForPath(route.path);
		if (!context) return [];
		try {
			const contact = await requireConvex().query(api.contacts.contacts.get, {
				contactId: context.contactId as Id<'contacts'>,
			});
			return contact?.email ? [contact.email] : [];
		} catch {
			return [];
		}
	}

	/**
	 * Open a real composer over the current page. With no mailbox at all it
	 * lands on the Postbox, where `PostboxMailboxGuard` explains why there is
	 * nothing to compose from instead of a silently dead keystroke.
	 */
	async function openCompose(): Promise<void> {
		const [mailboxId, prefillTo] = await Promise.all([
			resolveComposeMailboxId(),
			resolvePrefillTo(),
		]);
		if (!mailboxId) {
			await navigateTo(POSTBOX_COMPOSE_ROUTE);
			return;
		}
		stack.open(prefillTo.length > 0 ? { mailboxId, prefillTo } : { mailboxId });
	}

	/** Open the contacts list with its Add contact dialog already up. */
	async function openNewContact(): Promise<void> {
		await navigateTo(NEW_CONTACT_ROUTE);
	}

	return { openCompose, openNewContact };
}
