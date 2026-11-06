/**
 * Personal address book (mailContacts) — list + upsert + remove, the
 * restore that undoes a removal, and handing an edited synced row back to its
 * CardDAV card.
 * The autocomplete/recording backend already exists; this is the management UI's
 * data layer.
 */
import { api } from '@owlat/api';
import type { Doc, Id } from '@owlat/api/dataModel';
import { VCARD_MAX_ENTRIES } from '@owlat/shared/postboxVcardLimits';

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
	const restoreOp = useBackendOperation(api.mail.contactsUndo.restore, {
		label: () => t('shared.postbox.usePostboxContacts.restoreContact'),
	});
	const resumeCardDavOp = useBackendOperation(api.mail.contactsCardDav.resumeCardDavUpdates, {
		label: () => t('shared.postbox.usePostboxContacts.resumeCardDav'),
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

	/**
	 * Put a removed row back from the copy the page held, every detail and the
	 * CardDAV link included; `photoRemovalId` (from `remove`) brings its picture.
	 */
	async function restore(
		contact: Doc<'mailContacts'>,
		photoRemovalId?: Id<'_scheduled_functions'>
	) {
		if (!mailboxId.value) return { ok: false } as const;
		return restoreOp.run({
			mailboxId: mailboxId.value,
			contact: {
				email: contact.email,
				displayName: contact.displayName,
				organization: contact.organization,
				phones: contact.phones,
				postalAddresses: contact.postalAddresses,
				photoStorageId: contact.photoStorageId,
				importedAt: contact.importedAt,
				cardDavSource: contact.cardDavSource,
				isVip: contact.isVip,
				isScreenerAccepted: contact.isScreenerAccepted,
				useCount: contact.useCount,
				lastUsedAt: contact.lastUsedAt,
				createdAt: contact.createdAt,
			},
			...(photoRemovalId ? { photoRemovalId } : {}),
		});
	}

	/** Let the CardDAV card replace a synced row the person edited again. */
	async function resumeCardDav(contactId: Id<'mailContacts'>) {
		return resumeCardDavOp.run({ contactId });
	}

	return { contacts, isLoading, error, refetch, save, remove, restore, resumeCardDav };
}
