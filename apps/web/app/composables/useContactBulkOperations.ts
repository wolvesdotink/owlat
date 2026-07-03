import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { BATCH_SIZES } from '~/constants/operations';
import { buildContactsCsv, downloadCsv, fetchPropertyValuesChunked, type CsvContact } from '~/utils/contactsCsv';

export function useContactBulkOperations(deps: {
	bulkSelection: ReturnType<typeof useBulkSelection<Id<'contacts'>>>;
	topics: Ref<Array<{ _id: Id<'topics'>; name: string }> | undefined>;
	contactProperties: Ref<Array<{ _id: string; label: string }> | null | undefined>;
	debouncedSearch: Ref<string>;
}) {
	const convex = useConvex();
	const { showToast } = useToast();

	const { run: addContactsToList } = useBackendOperation(api.topics.bulk.addContacts, {
		label: 'Add contacts to topic',
	});
	const { run: removeContactsFromList } = useBackendOperation(api.topics.bulk.removeContacts, {
		label: 'Remove contacts from topic',
	});
	const { run: bulkDeleteContacts } = useBackendOperation(api.contacts.contacts.bulkDelete, {
		label: 'Delete contacts',
	});

	// Shared batch runner: owns the in-progress / progress / type state and the
	// per-batch loop so the add/remove/delete/export handlers don't each
	// re-implement the same `Math.ceil` slicing + progress arithmetic.
	const bulkOp = useBulkOperation();
	const isBulkOperationInProgress = bulkOp.isInProgress;
	const bulkOperationProgress = bulkOp.progress;
	const bulkOperationType = bulkOp.operationType;

	// Sentinel thrown inside a batch operation when the backend op returns
	// `undefined` (the operation layer already surfaced the error via toast). It
	// aborts the run via `execute`'s try/catch without a second error toast.
	const ABORTED = Symbol('bulk-aborted');

	// State
	const isBulkActionDropdownOpen = ref(false);
	const isAddToListDropdownOpen = ref(false);
	const isRemoveFromListDropdownOpen = ref(false);
	const isLoadingAllMatching = ref(false);
	const isBulkDeleteModalOpen = ref(false);
	const bulkDeleteCount = ref(0);

	const selectAllMatchingFilter = async () => {
		if (!convex) return;
		isLoadingAllMatching.value = true;

		try {
			const { ids, truncated } = await convex.query(
				api.contacts.organization.listAllIdsByOrganization,
				{ search: deps.debouncedSearch.value || undefined },
			);
			deps.bulkSelection.setAllMatching(ids);
			if (truncated) {
				// The server capped the selection; a bulk action would otherwise act
				// on only the first 10k of a larger matching set without the user
				// knowing. Surface it so destructive ops aren't silently partial.
				showToast(
					`Selected the first ${ids.length.toLocaleString()} matching contacts. Refine your filter to act on the rest.`,
					'error',
				);
			}
		} catch {
			showToast('Failed to select all contacts. Please try again.', 'error');
		} finally {
			isLoadingAllMatching.value = false;
		}
	};

	const handleBulkAddToList = async (listId: Id<'topics'>) => {
		if (deps.bulkSelection.selectedIds.value.size === 0) return;

		isAddToListDropdownOpen.value = false;
		isBulkActionDropdownOpen.value = false;

		const selectedContactIds = deps.bulkSelection.getSelectedArray();
		const listName = deps.topics.value?.find((l) => l._id === listId)?.name || 'list';

		const { success } = await bulkOp.execute(
			selectedContactIds,
			async (batch) => {
				const result = await addContactsToList({ topicId: listId, contactIds: batch });
				if (result === undefined) throw ABORTED;
				return result;
			},
			{ batchSize: BATCH_SIZES.CONTACTS_ADD_TO_LIST, type: 'add' },
		);
		if (!success) return;

		showToast(
			`Added ${selectedContactIds.length} contact${selectedContactIds.length !== 1 ? 's' : ''} to "${listName}"`
		);
		deps.bulkSelection.clearSelection();
	};

	const handleBulkRemoveFromList = async (listId: Id<'topics'>) => {
		if (deps.bulkSelection.selectedIds.value.size === 0) return;

		isRemoveFromListDropdownOpen.value = false;
		isBulkActionDropdownOpen.value = false;

		const selectedContactIds = deps.bulkSelection.getSelectedArray();
		const listName = deps.topics.value?.find((l) => l._id === listId)?.name || 'list';

		const { success } = await bulkOp.execute(
			selectedContactIds,
			async (batch) => {
				const result = await removeContactsFromList({ topicId: listId, contactIds: batch });
				if (result === undefined) throw ABORTED;
				return result;
			},
			{ batchSize: BATCH_SIZES.CONTACTS_REMOVE_FROM_LIST, type: 'remove' },
		);
		if (!success) return;

		showToast(
			`Removed ${selectedContactIds.length} contact${selectedContactIds.length !== 1 ? 's' : ''} from "${listName}"`
		);
		deps.bulkSelection.clearSelection();
	};

	const openBulkDeleteModal = () => {
		bulkDeleteCount.value = deps.bulkSelection.selectedIds.value.size;
		isBulkDeleteModalOpen.value = true;
		isBulkActionDropdownOpen.value = false;
	};

	const handleBulkDelete = async () => {
		if (deps.bulkSelection.selectedIds.value.size === 0) return;

		isBulkDeleteModalOpen.value = false;

		const selectedContactIds = deps.bulkSelection.getSelectedArray();

		const { success, results } = await bulkOp.execute(
			selectedContactIds,
			async (batch) => {
				const result = await bulkDeleteContacts({ contactIds: batch });
				if (result === undefined) throw ABORTED;
				return result;
			},
			{ batchSize: BATCH_SIZES.CONTACTS_DELETE, type: 'delete' },
		);
		if (!success) return;

		const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
		const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

		if (totalFailed > 0) {
			showToast(
				`Deleted ${totalDeleted} contact${totalDeleted !== 1 ? 's' : ''}. ${totalFailed} failed.`
			);
		} else {
			showToast(`Deleted ${totalDeleted} contact${totalDeleted !== 1 ? 's' : ''} successfully`);
		}

		deps.bulkSelection.clearSelection();
	};

	const handleBulkExport = async () => {
		if (!convex || deps.bulkSelection.selectedIds.value.size === 0)
			return;

		isBulkActionDropdownOpen.value = false;

		// Export is a single unit of work (query → filter → build → download), but
		// runs through the same `bulkOp` runner so the in-progress/type state is
		// shared with the batch handlers and the progress bar reads 'export'.
		await bulkOp.execute(
			[deps.bulkSelection.getSelectedArray()],
			async ([selectedContactIds]) => {
				try {
					// Scope the export window to the same active search the selection was
					// built against (listAllIdsByOrganization above), so a search-scoped
					// selection isn't intersected with a disjoint unfiltered window.
					const allContacts = await convex.query(
						api.contacts.organization.listForExportByOrganization,
						{ search: deps.debouncedSearch.value || undefined }
					);
					const contactsToExport =
						allContacts?.filter((c: { _id: string }) => selectedContactIds!.includes(c._id as Id<'contacts'>)) || [];

					if (contactsToExport.length === 0) {
						showToast('No contacts to export');
						return;
					}

					// Chunk the ids so each query stays under the Convex per-transaction
					// index-range-read cap — exporting past ~2,000 contacts otherwise threw.
					const propertyValues = await fetchPropertyValuesChunked(
						contactsToExport.map((c: { _id: string }) => c._id as Id<'contacts'>),
						(chunk) =>
							convex.query(api.contacts.organization.getPropertyValuesForContacts, {
								contactIds: chunk,
							}),
					);

					const csv = buildContactsCsv(
						contactsToExport as CsvContact[],
						propertyValues as Record<string, Record<string, string>>,
						deps.contactProperties.value || [],
					);

					const timestamp = new Date().toISOString().slice(0, 10);
					const filename = `contacts-selected-${timestamp}.csv`;
					downloadCsv(csv, filename);

					showToast(
						`Exported ${contactsToExport.length} contact${contactsToExport.length !== 1 ? 's' : ''} to ${filename}`
					);
					deps.bulkSelection.clearSelection();
				} catch {
					showToast('Export failed. Please try again.', 'error');
				}
			},
			{ type: 'export' },
		);
	};

	return {
		// State
		isBulkActionDropdownOpen,
		isAddToListDropdownOpen,
		isRemoveFromListDropdownOpen,
		isBulkOperationInProgress,
		bulkOperationProgress,
		bulkOperationType,
		isLoadingAllMatching,
		isBulkDeleteModalOpen,
		bulkDeleteCount,
		// Actions
		selectAllMatchingFilter,
		handleBulkAddToList,
		handleBulkRemoveFromList,
		openBulkDeleteModal,
		handleBulkDelete,
		handleBulkExport,
	};
}
