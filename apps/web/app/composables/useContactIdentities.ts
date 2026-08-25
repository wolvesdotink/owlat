import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useContactIdentities(contactId: Ref<Id<'contacts'>>) {
	const { t } = useI18n();

	// Fetch identities
	const { data: identities, isLoading: identitiesLoading } = useConvexQuery(
		api.contacts.identities.listByContact,
		() => ({ contactId: contactId.value })
	);

	// Fetch merge suggestions
	const { data: mergeSuggestions, isLoading: mergeLoading } = useConvexQuery(
		api.contacts.identities.getMergeSuggestions,
		() => ({ contactId: contactId.value })
	);

	// Mutations
	const { run: addIdentity } = useBackendOperation(api.contacts.identities.addIdentity, {
		label: () => t('shared.useContactIdentities.addIdentityOperation'),
	});
	const { run: removeIdentity } = useBackendOperation(api.contacts.identities.removeIdentity, {
		label: () => t('shared.useContactIdentities.removeIdentityOperation'),
	});
	const { run: verifyIdentity } = useBackendOperation(api.contacts.identities.verifyIdentity, {
		label: () => t('shared.useContactIdentities.verifyIdentityOperation'),
	});
	const { run: mergeContacts } = useBackendOperation(api.contacts.identities.mergeContacts, {
		label: () => t('shared.useContactIdentities.mergeContactsOperation'),
	});

	// Add form state
	const showAddForm = ref(false);
	const addForm = reactive({
		channel: 'email',
		identifier: '',
		isPrimary: false,
	});
	const isAdding = ref(false);

	const handleAddIdentity = async () => {
		if (!addForm.identifier.trim()) return;
		isAdding.value = true;
		const result = await addIdentity({
			contactId: contactId.value,
			channel: addForm.channel,
			identifier: addForm.identifier.trim(),
			isPrimary: addForm.isPrimary,
		});
		isAdding.value = false;
		if (!result.ok) return;
		addForm.channel = 'email';
		addForm.identifier = '';
		addForm.isPrimary = false;
		showAddForm.value = false;
	};

	const handleRemoveIdentity = async (identityId: Id<'contactIdentities'>) => {
		await removeIdentity({ identityId });
	};

	const handleVerifyIdentity = async (identityId: Id<'contactIdentities'>) => {
		await verifyIdentity({ identityId });
	};

	const handleMergeContacts = async (sourceContactId: Id<'contacts'>) => {
		await mergeContacts({
			targetContactId: contactId.value,
			sourceContactId,
		});
	};

	// Channel helpers. `label` is a message key — the identities tab renders it
	// through `t()`, so an unmapped channel can fall back to its raw value.
	const channelOptions = [
		{ value: 'email', label: 'shared.useContactIdentities.channels.email', icon: 'lucide:mail' },
		{ value: 'phone', label: 'shared.useContactIdentities.channels.phone', icon: 'lucide:phone' },
		{
			value: 'whatsapp',
			label: 'shared.useContactIdentities.channels.whatsapp',
			icon: 'lucide:message-circle',
		},
		{
			value: 'twitter',
			label: 'shared.useContactIdentities.channels.twitter',
			icon: 'lucide:twitter',
		},
		{
			value: 'linkedin',
			label: 'shared.useContactIdentities.channels.linkedin',
			icon: 'lucide:linkedin',
		},
		{ value: 'other', label: 'shared.useContactIdentities.channels.other', icon: 'lucide:link' },
	];

	const getChannelIcon = (channel: string) => {
		return channelOptions.find((c) => c.value === channel)?.icon ?? 'lucide:link';
	};

	const getChannelLabel = (channel: string) => {
		return channelOptions.find((c) => c.value === channel)?.label ?? channel;
	};

	return {
		identities,
		identitiesLoading,
		mergeSuggestions,
		mergeLoading,
		showAddForm,
		addForm,
		isAdding,
		channelOptions,
		handleAddIdentity,
		handleRemoveIdentity,
		handleVerifyIdentity,
		handleMergeContacts,
		getChannelIcon,
		getChannelLabel,
	};
}
