/**
 * The CardDAV address book a mailbox syncs into its Postbox contacts
 * (api.mail.contactsCardDav*): its state, connecting one, a sync on request and
 * disconnecting. These are the mailbox's own contacts, not the audience
 * contacts. The password goes to the server once, in the connect call, and is
 * never read back.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export type CardDavConnectFailure =
	| 'auth'
	| 'unreachable'
	| 'not_carddav'
	| 'no_address_book'
	| 'too_large'
	| 'failed'
	| 'invalid_url'
	| 'forbidden'
	| 'already_connected';

export function usePostboxCardDav(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	const { data, isLoading } = useConvexQuery(api.mail.contactsCardDav.getForMailbox, () =>
		mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
	);
	const account = computed(() => data.value ?? null);

	const connectOp = useBackendOperation(api.mail.contactsCardDavActions.connect, {
		label: () => t('dashboard.postbox.contacts.carddav.connect'),
	});
	const syncOp = useBackendOperation(api.mail.contactsCardDav.syncNow, {
		label: () => t('dashboard.postbox.contacts.carddav.syncNow'),
	});
	const disconnectOp = useBackendOperation(api.mail.contactsCardDav.disconnect, {
		label: () => t('dashboard.postbox.contacts.carddav.disconnect'),
	});

	/** Connect a book; the failure reason when the server or the mailbox refused it. */
	async function connect(input: {
		serverUrl: string;
		username: string;
		password: string;
	}): Promise<{ ok: true } | { ok: false; reason?: CardDavConnectFailure }> {
		if (!mailboxId.value) return { ok: false };
		const result = await connectOp.run({ mailboxId: mailboxId.value, ...input });
		if (!result.ok) return { ok: false };
		return result.result;
	}

	async function syncNow() {
		if (!mailboxId.value) return { ok: false } as const;
		return syncOp.run({ mailboxId: mailboxId.value });
	}

	async function disconnect() {
		if (!mailboxId.value) return { ok: false } as const;
		return disconnectOp.run({ mailboxId: mailboxId.value });
	}

	return {
		account,
		isLoading,
		isConnecting: connectOp.isLoading,
		isSyncing: syncOp.isLoading,
		isDisconnecting: disconnectOp.isLoading,
		connect,
		syncNow,
		disconnect,
	};
}
