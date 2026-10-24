import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { BATCH_SIZES } from '~/constants/operations';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import { usePostboxTriageUndo } from '~/composables/postbox/usePostboxTriageUndo';
import {
	buildContactsCsv,
	downloadCsv,
	fetchPropertyValuesChunked,
	type CsvContact,
} from '~/utils/contactsCsv';

export function useContactBulkOperations(deps: {
	bulkSelection: ReturnType<typeof useBulkSelection<Id<'contacts'>>>;
	topics: Ref<Array<{ _id: Id<'topics'>; name: string }> | undefined>;
	contactProperties: Ref<Array<{ _id: string; label: string }> | null | undefined>;
	debouncedSearch: Ref<string>;
}) {
	const convex = useConvex();
	const { showToast } = useToast();
	const { t, locale } = useI18n();

	const { run: addContactsToList } = useBackendOperation(api.topics.bulk.addContacts, {
		label: () => t('shared.useContactBulkOperations.addContactsOperation'),
	});
	const { run: removeContactsFromList } = useBackendOperation(api.topics.bulk.removeContacts, {
		label: () => t('shared.useContactBulkOperations.removeContactsOperation'),
	});
	const { run: undoAddContacts } = useBackendOperation(api.topics.bulk.undoAddContacts, {
		label: () => t('shared.useContactBulkOperations.undoAddOperation'),
	});
	const { run: undoRemoveContacts } = useBackendOperation(api.topics.bulk.undoRemoveContacts, {
		label: () => t('shared.useContactBulkOperations.undoRemoveOperation'),
	});
	// Topic edits ride the app's one undo stack: the same toast, Ctrl+Z and
	// coalescing as the Postbox triage and the marketing deletes.
	const undoStack = usePostboxTriageUndo();
	const { run: bulkDeleteContacts } = useBackendOperation(api.contacts.contacts.bulkDelete, {
		label: () => t('shared.useContactBulkOperations.deleteContactsOperation'),
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

	/**
	 * Offer the undo of a bulk topic edit that changed `receipt.length` contacts
	 * (the server's receipt: an existing member or a non-member is not in it).
	 * The inverse sends the receipt back in the forward call's batch size and
	 * stops at the first batch that fails, which reports itself.
	 */
	function offerTopicUndo<R>(args: {
		kind: 'add' | 'remove';
		listId: Id<'topics'>;
		listName: string;
		receipt: R[];
		batchSize: number;
		undoBatch: (chunk: R[]) => Promise<BackendOperationResult<unknown>>;
	}) {
		const key =
			args.kind === 'add'
				? 'shared.useContactBulkOperations.addedToList'
				: 'shared.useContactBulkOperations.removedFromList';
		const labelFor = (count: number) => t(key, { count, list: args.listName }, count);
		undoStack.register({
			label: labelFor(args.receipt.length),
			group: {
				key: `contacts:${args.kind}:${args.listId}`,
				count: args.receipt.length,
				label: labelFor,
			},
			inverse: async () => {
				for (let i = 0; i < args.receipt.length; i += args.batchSize) {
					const outcome = await args.undoBatch(args.receipt.slice(i, i + args.batchSize));
					if (!outcome.ok) return;
				}
			},
		});
	}

	const selectAllMatchingFilter = async () => {
		if (!convex) return;
		isLoadingAllMatching.value = true;

		try {
			const { ids, truncated } = await convex.query(
				api.contacts.organization.listAllIdsByOrganization,
				{ search: deps.debouncedSearch.value || undefined }
			);
			deps.bulkSelection.setAllMatching(ids);
			if (truncated) {
				// The server capped the selection; a bulk action would otherwise act
				// on only the first 10k of a larger matching set without the user
				// knowing. Surface it so destructive ops aren't silently partial.
				showToast(
					t('shared.useContactBulkOperations.selectionTruncated', {
						count: new Intl.NumberFormat(locale.value).format(ids.length),
					}),
					'error'
				);
			}
		} catch {
			showToast(t('shared.useContactBulkOperations.selectAllFailed'), 'error');
		} finally {
			isLoadingAllMatching.value = false;
		}
	};

	const handleBulkAddToList = async (listId: Id<'topics'>) => {
		if (deps.bulkSelection.selectedIds.value.size === 0) return;

		isAddToListDropdownOpen.value = false;
		isBulkActionDropdownOpen.value = false;

		const selectedContactIds = deps.bulkSelection.getSelectedArray();
		const listName =
			deps.topics.value?.find((l) => l._id === listId)?.name ||
			t('shared.useContactBulkOperations.listFallback');

		const { success, results } = await bulkOp.execute(
			selectedContactIds,
			async (batch) => {
				const result = await addContactsToList({ topicId: listId, contactIds: batch });
				if (!result.ok) throw ABORTED;
				return result.result;
			},
			{ batchSize: BATCH_SIZES.CONTACTS_ADD_TO_LIST, type: 'add' }
		);

		// Batches that landed before a failed one are real changes: they get their
		// count and their undo too, beside the failure's own error toast.
		const added = results.flatMap((r) => r.added);
		if (added.length > 0) {
			offerTopicUndo({
				kind: 'add',
				listId,
				listName,
				receipt: added,
				batchSize: BATCH_SIZES.CONTACTS_ADD_TO_LIST,
				undoBatch: (chunk) => undoAddContacts({ topicId: listId, added: chunk }),
			});
		} else if (success) {
			showToast(t('shared.useContactBulkOperations.nothingAdded', { list: listName }), 'info');
		}
		if (success) deps.bulkSelection.clearSelection();
	};

	const handleBulkRemoveFromList = async (listId: Id<'topics'>) => {
		if (deps.bulkSelection.selectedIds.value.size === 0) return;

		isRemoveFromListDropdownOpen.value = false;
		isBulkActionDropdownOpen.value = false;

		const selectedContactIds = deps.bulkSelection.getSelectedArray();
		const listName =
			deps.topics.value?.find((l) => l._id === listId)?.name ||
			t('shared.useContactBulkOperations.listFallback');

		const { success, results } = await bulkOp.execute(
			selectedContactIds,
			async (batch) => {
				const result = await removeContactsFromList({ topicId: listId, contactIds: batch });
				if (!result.ok) throw ABORTED;
				return result.result;
			},
			{ batchSize: BATCH_SIZES.CONTACTS_REMOVE_FROM_LIST, type: 'remove' }
		);

		// As for the add: what landed before a failure is counted and undoable.
		const removed = results.flatMap((r) => r.removed);
		if (removed.length > 0) {
			offerTopicUndo({
				kind: 'remove',
				listId,
				listName,
				receipt: removed,
				batchSize: BATCH_SIZES.CONTACTS_REMOVE_FROM_LIST,
				undoBatch: (chunk) => undoRemoveContacts({ topicId: listId, removed: chunk }),
			});
		} else if (success) {
			showToast(t('shared.useContactBulkOperations.nothingRemoved', { list: listName }), 'info');
		}
		if (success) deps.bulkSelection.clearSelection();
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
				if (!result.ok) throw ABORTED;
				return result.result;
			},
			{ batchSize: BATCH_SIZES.CONTACTS_DELETE, type: 'delete' }
		);
		if (!success) return;

		const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
		const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

		if (totalFailed > 0) {
			showToast(
				t(
					'shared.useContactBulkOperations.deletedWithFailures',
					{ count: totalDeleted, failed: totalFailed },
					totalDeleted
				)
			);
		} else {
			showToast(
				t('shared.useContactBulkOperations.deleted', { count: totalDeleted }, totalDeleted)
			);
		}

		deps.bulkSelection.clearSelection();
	};

	const handleBulkExport = async () => {
		if (!convex || deps.bulkSelection.selectedIds.value.size === 0) return;

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
						allContacts?.filter((c: { _id: string }) =>
							selectedContactIds!.includes(c._id as Id<'contacts'>)
						) || [];

					if (contactsToExport.length === 0) {
						showToast(t('shared.useContactBulkOperations.noContactsToExport'));
						return;
					}

					// Chunk the ids so each query stays under the Convex per-transaction
					// index-range-read cap — exporting past ~2,000 contacts otherwise threw.
					const propertyValues = await fetchPropertyValuesChunked(
						contactsToExport.map((c: { _id: string }) => c._id as Id<'contacts'>),
						(chunk) =>
							convex.query(api.contacts.organization.getPropertyValuesForContacts, {
								contactIds: chunk,
							})
					);

					const csv = buildContactsCsv(
						contactsToExport as CsvContact[],
						propertyValues as Record<string, Record<string, string>>,
						deps.contactProperties.value || []
					);

					const timestamp = new Date().toISOString().slice(0, 10);
					const filename = `contacts-selected-${timestamp}.csv`;
					downloadCsv(csv, filename);

					showToast(
						t(
							'shared.useContactBulkOperations.exported',
							{ count: contactsToExport.length, filename },
							contactsToExport.length
						)
					);
					deps.bulkSelection.clearSelection();
				} catch {
					showToast(t('shared.useContactBulkOperations.exportFailed'), 'error');
				}
			},
			{ type: 'export' }
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
