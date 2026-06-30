import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface ContactSearchResult {
	_id: Id<'contacts'>;
	email: string;
	firstName?: string;
	lastName?: string;
}

export function useContactRelationships(contactId: Ref<Id<'contacts'>>) {
	// Fetch relationships
	const { data: relationships, isLoading: relationshipsLoading } = useConvexQuery(
		api.contacts.relationships.listByContact,
		() => ({ contactId: contactId.value }),
	);

	// Contact picker for the Add Relationship form. The target contact is chosen
	// by searching name/email rather than pasting an opaque internal id — the
	// `_id` is never surfaced to copy. Debounced so each keystroke doesn't
	// re-subscribe the paginated query.
	const { searchQuery: targetSearch, debouncedSearch: targetSearchDebounced } =
		useDebouncedSearch(300);
	const { results: targetCandidatesRaw } = usePaginatedQuery(
		api.contacts.contacts.list,
		() => ({ search: targetSearchDebounced.value || undefined }),
		{ initialNumItems: 8 },
	);
	// Never offer the contact you're on as its own relationship target.
	const targetCandidates = computed(() =>
		(targetCandidatesRaw.value as ContactSearchResult[]).filter(
			(c) => c._id !== contactId.value,
		),
	);

	const contactLabel = (contact: ContactSearchResult): string => {
		const name = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
		return name || contact.email;
	};

	// Mutations
	const { run: createRelationship } = useBackendOperation(api.contacts.relationships.create, {
		label: 'Add relationship',
	});
	const { run: removeRelationship } = useBackendOperation(api.contacts.relationships.remove, {
		label: 'Remove relationship',
	});
	const { run: updateConfidence } = useBackendOperation(
		api.contacts.relationships.updateConfidence,
		{ label: 'Update relationship confidence' },
	);

	// Add form state
	const showAddForm = ref(false);
	const addForm = reactive({
		toContactId: '' as string,
		// Display label for the chosen target contact (name or email), shown as a
		// chip once a search result is picked.
		toContactLabel: '' as string,
		relationship: 'colleague',
		confidence: 0.8,
	});
	const isAdding = ref(false);

	const selectTargetContact = (contact: ContactSearchResult) => {
		addForm.toContactId = contact._id;
		addForm.toContactLabel = contactLabel(contact);
		targetSearch.value = '';
	};

	const clearTargetContact = () => {
		addForm.toContactId = '';
		addForm.toContactLabel = '';
	};

	const handleAddRelationship = async () => {
		if (!addForm.toContactId) return;
		isAdding.value = true;
		const result = await createRelationship({
			fromContactId: contactId.value,
			toContactId: addForm.toContactId as Id<'contacts'>,
			relationship: addForm.relationship,
			confidence: addForm.confidence,
		});
		isAdding.value = false;
		if (result === undefined) return;
		addForm.toContactId = '';
		addForm.toContactLabel = '';
		addForm.relationship = 'colleague';
		addForm.confidence = 0.8;
		targetSearch.value = '';
		showAddForm.value = false;
	};

	const handleRemoveRelationship = async (relationshipId: Id<'contactRelationships'>) => {
		await removeRelationship({ relationshipId });
	};

	// Confidence is set once in the Add form, but it's an estimate the user may
	// want to refine later. Clamp to the same [0, 1] range the create form uses
	// before patching the existing row (works for incoming and outgoing rows
	// alike — both map to a single contactRelationships document).
	const handleUpdateConfidence = async (
		relationshipId: Id<'contactRelationships'>,
		confidence: number,
	) => {
		const clamped = Math.min(1, Math.max(0, confidence));
		await updateConfidence({ relationshipId, confidence: clamped });
	};

	// Relationship type helpers
	const relationshipTypes = [
		'colleague',
		'manager_of',
		'reports_to',
		'client',
		'vendor',
		'partner',
		'advisor',
		'investor',
		'friend',
		'other',
	];

	const getRelationshipIcon = (relationship: string) => {
		const icons: Record<string, string> = {
			colleague: 'lucide:users',
			manager_of: 'lucide:crown',
			reports_to: 'lucide:arrow-up-right',
			client: 'lucide:briefcase',
			vendor: 'lucide:package',
			partner: 'lucide:handshake',
			advisor: 'lucide:graduation-cap',
			investor: 'lucide:trending-up',
			friend: 'lucide:heart',
			other: 'lucide:link',
		};
		return icons[relationship] || 'lucide:link';
	};

	const getDirectionLabel = (direction: 'incoming' | 'outgoing') => {
		return direction === 'outgoing' ? 'to' : 'from';
	};

	return {
		relationships,
		relationshipsLoading,
		showAddForm,
		addForm,
		isAdding,
		relationshipTypes,
		targetSearch,
		targetCandidates,
		contactLabel,
		selectTargetContact,
		clearTargetContact,
		handleAddRelationship,
		handleRemoveRelationship,
		handleUpdateConfidence,
		getRelationshipIcon,
		getDirectionLabel,
	};
}
