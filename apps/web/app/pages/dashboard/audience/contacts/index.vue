<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ImportResults } from '~/composables/useCsvImport';
import AddContactModal from '~/components/contacts/list/AddContactModal.vue';
import ContactsBulkActions from '~/components/contacts/list/BulkActions.vue';
import ContactsBulkProgress from '~/components/contacts/list/BulkProgress.vue';
import ContactCardList from '~/components/contacts/list/ContactCardList.vue';
import ContactTable from '~/components/contacts/list/ContactTable.vue';
import ContactsImportMenu from '~/components/contacts/list/ImportMenu.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.contacts.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Core dependencies
const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();
const router = useRouter();
const route = useRoute();
const { showToast } = useToast();
const { canManageContacts } = usePermissions();

// Data table controls (search, sort, pagination). Only `createdAt` is
// server-sortable — it is the sole column with a soft-delete-leading index, so
// it can be reordered across the whole cursor-paginated set without thinning a
// page. Email/name have no such index (a post-filter would drop rows), so they
// stay plain headers rather than offering a misleading partial-page sort.
type SortField = 'createdAt';
const {
	searchQuery,
	debouncedSearch,
	sortBy,
	sortOrder,
	toggleSort,
	getSortIcon,
	getAriaSort,
	pageSize,
} = useDataTable<SortField>({ defaultSort: 'createdAt', sortableFields: ['createdAt'] });
// Search results are relevance-ordered and the backend ignores sort/order on
// that path (lib/listing.ts trims the same way), so while a search is active the
// Created header claims no sort, by chevron or by aria-sort, and its button is
// inert (aria-disabled but focusable, so its hint is still announced).
const sortApplies = computed(() => !debouncedSearch.value.trim());

// Bulk selection
const bulkSelection = useBulkSelection<Id<'contacts'>>();

// Bulk operations
const bulkOp = useBulkOperation();

// CSV Import composable
const csvImport = useCsvImport();

// Keyboard shortcuts
const { registerNewShortcut, registerEscapeHandler, unregisterShortcut } = useKeyboardShortcuts();

// Below `md` the columns can't fit, so the same rows render as a card list.
// Exactly one of the two trees is mounted: the app runs with `ssr: false`, so
// the first value is already the real one, and mounting both (a CSS-only
// `md:hidden` switch) doubles the row DOM and lets the copies drift apart.
const tableFits = useDataTableViewport();

// Modal states
const isExportModalOpen = ref(false);
const isIntegrationImportModalOpen = ref(false);

// Clear selection when search or sort changes (the page is re-fetched server-side)
watch([debouncedSearch, sortBy, sortOrder], () => {
	bulkSelection.clearSelection();
});

// Fetch contacts with cursor-based pagination. Sort args are sent to the backend
// so reordering spans the whole set, not just the loaded page (search ignores
// them — search results are relevance-ordered).
const {
	results: contacts,
	status: paginationStatus,
	loadMore,
	isLoading: contactsLoading,
	error: contactsError,
	refetch: refetchContacts,
} = usePaginatedQuery(
	api.contacts.contacts.list,
	() => ({
		search: debouncedSearch.value || undefined,
		sort: sortBy.value,
		order: sortOrder.value,
	}),
	{ initialNumItems: pageSize, keepPreviousData: true }
);

// Fetch contact properties and topics
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);

const { results: topics } = useTopicsList();

// Mutations
const csvImportOperations = useContactCsvImportOperations(() =>
	(contactProperties.value ?? []).map((p: { key: string }) => p.key)
);

// Computed values
const isLoading = computed(() => teamLoading.value || contactsLoading.value);
const canLoadMore = computed(() => paginationStatus.value === 'CanLoadMore');
const isLoadingMore = computed(() => paginationStatus.value === 'LoadingMore');
const totalCount = computed(() => contacts.value?.length ?? 0);

const contactIds = computed(() =>
	(contacts.value ?? []).map((c: { _id: Id<'contacts'> }) => c._id)
);
const isAllPageSelected = computed(() => bulkSelection.isAllPageSelected(contactIds.value));
/** Some loaded contacts selected, not all: the select-all box reads "mixed". */
const isSomePageSelected = computed(
	() =>
		!isAllPageSelected.value &&
		contactIds.value.some((id) => bulkSelection.selectedIds.value.has(id))
);

// Showing count text
const showingText = computed(() => {
	const count = contacts.value?.length ?? 0;
	if (count === 0) return t('dashboard.audience.contacts.index.showing.empty');
	// Once every page is in, the count is the whole list — one line says so.
	if (paginationStatus.value === 'Exhausted') {
		return t('dashboard.audience.contacts.index.showing.all', { count }, count);
	}
	return t('dashboard.audience.contacts.index.showing.loaded', { count }, count);
});

// Handle load more
const handleLoadMore = () => {
	if (canLoadMore.value) {
		loadMore(pageSize);
	}
};

// ============================================
// Bulk Operations (composable)
// ============================================
const bulkOps = useContactBulkOperations({
	bulkSelection,
	topics: topics as Ref<Array<{ _id: Id<'topics'>; name: string }> | undefined>,
	contactProperties: contactProperties as Ref<Array<{ _id: string; label: string }> | undefined>,
	debouncedSearch,
});

const toggleSelectAll = () => {
	bulkSelection.toggleSelectAll(contactIds.value);
};

const toggleContactSelection = (contactId: Id<'contacts'>) => {
	bulkSelection.toggleSelection(contactId);
};

/** The desktop row's email link, its row click and its menu's "Open" all land here. */
const contactPath = (contactId: Id<'contacts'>) => `/dashboard/audience/contacts/${contactId}`;
const openContact = (contactId: Id<'contacts'>) => void router.push(contactPath(contactId));

// ============================================
// Add Contact Modal
// ============================================
const addModal = useFormModal({
	email: '',
	firstName: '',
	lastName: '',
	language: '',
});

// ============================================
// CSV Import
// ============================================
const processedCount = (results: ImportResults | null | undefined) =>
	results ? results.imported + results.updated : 0;

// A partial import is reported by the modal's completion step, with the rows
// it did not get to; the success toast is only for a run that took every row.
// `alreadyProcessed` keeps a retry's toast to the rows the retry itself sent,
// not the import's running total.
const toastCsvImport = (results: ImportResults | undefined, alreadyProcessed = 0) => {
	if (!results || csvImport.notImportedRowCount.value > 0) return;
	const count = processedCount(results) - alreadyProcessed;
	if (count <= 0) return;
	showToast(t('dashboard.audience.contacts.index.toasts.imported', { count }, count));
};

const handleCsvImport = async () => {
	toastCsvImport(
		await csvImport.startImport(
			csvImportOperations.importBatch,
			csvImportOperations.registerProperties
		)
	);
};

const handleCsvRetry = async () => {
	const alreadyProcessed = processedCount(csvImport.results.value);
	toastCsvImport(
		await csvImport.retryFailedRows(csvImportOperations.importBatch),
		alreadyProcessed
	);
};

// ============================================
// Lifecycle
// ============================================
onMounted(() => {
	// Auto-open the Add Contact modal when arriving via the audience overview
	// quick-action link (/dashboard/audience/contacts?action=add).
	if (canManageContacts.value && route.query['action'] === 'add') {
		addModal.open();
	}

	registerNewShortcut(() => {
		if (
			canManageContacts.value &&
			!addModal.isOpen.value &&
			!csvImport.isOpen.value &&
			!isExportModalOpen.value &&
			!isIntegrationImportModalOpen.value
		) {
			addModal.open();
		}
	});

	registerEscapeHandler(() => {
		if (addModal.isOpen.value) addModal.close();
		else if (csvImport.isOpen.value) csvImport.close();
		else if (isExportModalOpen.value) isExportModalOpen.value = false;
		else if (isIntegrationImportModalOpen.value) isIntegrationImportModalOpen.value = false;
	});
});

onUnmounted(() => {
	unregisterShortcut('global.newItem');
	unregisterShortcut('global.close');
});
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<AudienceTabs />
		<!-- Header -->
		<UiPageHeader
			:title="t('dashboard.audience.contacts.index.title')"
			:description="t('dashboard.audience.contacts.index.subtitle')"
			class="mb-6"
		>
			<template v-if="canManageContacts" #actions>
				<UiButton variant="secondary" @click="isExportModalOpen = true">
					<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
					{{ t('dashboard.audience.contacts.index.export') }}
				</UiButton>
				<!-- Import Dropdown -->
				<ContactsImportMenu
					@csv="csvImport.open()"
					@integrations="isIntegrationImportModalOpen = true"
				/>
				<UiButton @click="addModal.open()">
					<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
					{{ t('dashboard.audience.contacts.index.addContact') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<!-- Search Bar and Bulk Actions -->
		<div class="flex items-center gap-4 mb-6">
			<div class="max-w-md flex-1">
				<UiInput
					v-model="searchQuery"
					:placeholder="t('dashboard.audience.contacts.index.searchPlaceholder')"
				>
					<template #iconLeft><Icon name="lucide:search" /></template>
				</UiInput>
			</div>

			<!-- Bulk Actions -->
			<ContactsBulkActions
				:bulk-selection="bulkSelection"
				:bulk-ops="bulkOps"
				:topics="topics"
				:can-manage="canManageContacts"
				:total-count="totalCount"
				:loaded-count="contacts.length"
			/>

			<!-- Bulk Operation Progress -->
			<ContactsBulkProgress
				:active="bulkOps.isBulkOperationInProgress.value"
				:type="bulkOps.bulkOperationType.value"
				:progress="bulkOps.bulkOperationProgress.value"
			/>
		</div>

		<!-- Content -->
		<div class="card p-0 overflow-hidden">
			<UiQueryBoundary :error="contactsError" @retry="refetchContacts">
				<!-- Loading State -->
				<DashboardListSkeleton
					v-if="isLoading && contacts.length === 0"
					variant="table"
					leading
					:columns="4"
					:rows="8"
				/>

				<!-- Empty States -->
				<UiEmptyState
					v-else-if="!hasActiveOrganization"
					icon="lucide:users"
					:title="t('dashboard.audience.contacts.index.noTeam.title')"
					:description="t('dashboard.audience.contacts.index.noTeam.description')"
				/>

				<UiEmptyState
					v-else-if="!isLoading && contacts.length === 0 && !debouncedSearch"
					icon="lucide:users"
					:title="t('dashboard.audience.contacts.index.empty.title')"
					:description="
						canManageContacts
							? t('dashboard.audience.contacts.index.empty.descriptionManage')
							: t('dashboard.audience.contacts.index.empty.descriptionReadOnly')
					"
				/>

				<UiEmptyState
					v-else-if="!isLoading && contacts.length === 0 && debouncedSearch"
					icon="lucide:search"
					:title="t('dashboard.audience.contacts.index.noResults.title')"
					:description="
						t('dashboard.audience.contacts.index.noResults.description', { query: debouncedSearch })
					"
				>
					<template #action>
						<UiButton variant="secondary" @click="searchQuery = ''">{{
							t('dashboard.audience.contacts.index.clearSearch')
						}}</UiButton>
					</template>
				</UiEmptyState>

				<!-- Data Table -->
				<div v-else>
					<!-- Below md the columns can't fit — the same rows become a card
					     list (one tap opens the contact, the checkbox still selects). -->
					<ContactCardList
						v-if="!tableFits"
						:contacts="contacts"
						:selected-ids="bulkSelection.selectedIds.value"
						:can-manage="canManageContacts"
						:is-all-page-selected="isAllPageSelected"
						:is-some-page-selected="isSomePageSelected"
						@toggle-select-all="toggleSelectAll"
						@toggle-select="toggleContactSelection"
						@open="openContact"
					/>

					<ContactTable
						v-else
						:contacts="contacts"
						:selected-ids="bulkSelection.selectedIds.value"
						:can-manage="canManageContacts"
						:is-all-page-selected="isAllPageSelected"
						:is-some-page-selected="isSomePageSelected"
						:sort-applies="sortApplies"
						:created-aria-sort="getAriaSort('createdAt')"
						:created-sort-icon="getSortIcon('createdAt')"
						:contact-path="contactPath"
						@toggle-select-all="toggleSelectAll"
						@toggle-sort="toggleSort('createdAt')"
						@toggle-select="toggleContactSelection"
						@open="openContact"
					/>

					<!-- Load More -->
					<div
						v-if="totalCount > 0"
						class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 border-t border-border-subtle"
					>
						<p class="text-sm text-text-tertiary">{{ showingText }}</p>
						<UiButton
							v-if="canLoadMore"
							variant="secondary"
							:loading="isLoadingMore"
							@click="handleLoadMore"
						>
							<template v-if="!isLoadingMore" #iconLeft
								><Icon name="lucide:chevron-down" class="w-4 h-4"
							/></template>
							{{
								isLoadingMore
									? t('common.loading')
									: t('dashboard.audience.contacts.index.loadMore')
							}}
						</UiButton>
					</div>
				</div>
			</UiQueryBoundary>
		</div>

		<!-- Add Contact Modal -->
		<AddContactModal v-if="canManageContacts" :add-modal="addModal" />

		<!-- CSV Import Modal -->
		<LazyContactsCsvImportModal
			v-if="canManageContacts"
			:csv-import="csvImport"
			:topics="topics"
			@import="handleCsvImport"
			@retry="handleCsvRetry"
		/>

		<!-- Export Modal -->
		<LazyContactsExportModal
			v-if="canManageContacts"
			v-model:open="isExportModalOpen"
			:total-count="totalCount"
			:search-query="debouncedSearch"
			:contact-properties="contactProperties"
		/>

		<!-- Integration Import Modal -->
		<LazyContactsIntegrationImportModal
			v-if="canManageContacts"
			v-model:open="isIntegrationImportModalOpen"
			:topics="topics"
		/>

		<!-- Bulk Delete Modal -->
		<LazyContactsBulkDeleteModal
			v-if="canManageContacts"
			v-model:open="bulkOps.isBulkDeleteModalOpen.value"
			:count="bulkOps.bulkDeleteCount.value"
			@confirm="bulkOps.handleBulkDelete"
		/>
	</div>
</template>
