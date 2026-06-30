import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useContactIdentities(contactId: Ref<Id<'contacts'>>) {
	// Fetch identities
	const { data: identities, isLoading: identitiesLoading } = useConvexQuery(
		api.contacts.identities.listByContact,
		() => ({ contactId: contactId.value }),
	);

	// Fetch merge suggestions
	const { data: mergeSuggestions, isLoading: mergeLoading } = useConvexQuery(
		api.contacts.identities.getMergeSuggestions,
		() => ({ contactId: contactId.value }),
	);

	// Mutations
	const { run: addIdentity } = useBackendOperation(api.contacts.identities.addIdentity, {
		label: 'Add identity',
	});
	const { run: removeIdentity } = useBackendOperation(api.contacts.identities.removeIdentity, {
		label: 'Remove identity',
	});
	const { run: verifyIdentity } = useBackendOperation(api.contacts.identities.verifyIdentity, {
		label: 'Verify identity',
	});
	const { run: mergeContacts } = useBackendOperation(api.contacts.identities.mergeContacts, {
		label: 'Merge contacts',
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
		if (result === undefined) return;
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

	// Channel helpers
	const channelOptions = [
		{ value: 'email', label: 'Email', icon: 'lucide:mail' },
		{ value: 'phone', label: 'Phone', icon: 'lucide:phone' },
		{ value: 'whatsapp', label: 'WhatsApp', icon: 'lucide:message-circle' },
		{ value: 'twitter', label: 'Twitter/X', icon: 'lucide:twitter' },
		{ value: 'linkedin', label: 'LinkedIn', icon: 'lucide:linkedin' },
		{ value: 'other', label: 'Other', icon: 'lucide:link' },
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
