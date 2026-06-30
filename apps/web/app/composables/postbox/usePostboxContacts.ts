/**
 * Personal address book (mailContacts) — list + upsert + remove.
 * The autocomplete/recording backend already exists; this is the management UI's
 * data layer.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxContacts(mailboxId: Ref<Id<'mailboxes'> | null>) {
	const { data, isLoading } = useConvexQuery(api.mail.contacts.list, () =>
		mailboxId.value ? { mailboxId: mailboxId.value, limit: 500 } : 'skip'
	);
	const contacts = computed(() => data.value ?? []);

	const upsertOp = useBackendOperation(api.mail.contacts.upsert, { label: 'Save contact' });
	const removeOp = useBackendOperation(api.mail.contacts.remove, { label: 'Remove contact' });

	async function save(input: { email: string; displayName?: string; organization?: string }) {
		if (!mailboxId.value) return undefined;
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

	return { contacts, isLoading, save, remove };
}
