/**
 * Personal address book (mailContacts) — list + upsert + remove.
 * The autocomplete/recording backend already exists; this is the management UI's
 * data layer.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { VCARD_MAX_ENTRIES } from '@owlat/shared/postboxVcard';

export function usePostboxContacts(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { t } = useI18n();
	// The page holds one import's worth of rows (the server's list cap).
	const { data, isLoading, error, refetch } = useConvexQuery(api.mail.contacts.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value, limit: VCARD_MAX_ENTRIES } : 'skip'
	);
	const contacts = computed(() => data.value ?? []);

	const upsertOp = useBackendOperation(api.mail.contacts.upsert, {
		label: () => t('shared.postbox.usePostboxContacts.saveContact'),
	});
	const removeOp = useBackendOperation(api.mail.contacts.remove, {
		label: () => t('shared.postbox.usePostboxContacts.removeContact'),
	});

	async function save(input: { email: string; displayName?: string; organization?: string }) {
		if (!mailboxId.value) return { ok: false } as const;
		return upsertOp.run({
			mailboxId: mailboxId.value,
			email: input.email,
			displayName: input.displayName,
			organization: input.organization,
		});
	}

	async function remove(contactId: Id<'mailContacts'>) {
		return removeOp.run({ contactId });
	}

	return { contacts, isLoading, error, refetch, save, remove };
}
