<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import { languageSelectOptions } from '~/data/languageOptions';
import { isValidEmail } from '~/utils/validation';

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
const { searchQuery, debouncedSearch, sortBy, sortOrder, toggleSort, getSortIcon, pageSize } =
	useDataTable<SortField>({ defaultSort: 'createdAt', sortableFields: ['createdAt'] });

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
const { run: createContact } = useBackendOperation(api.contacts.contacts.create, {
	label: () => t('dashboard.audience.contacts.index.operations.addContact'),
});
const { run: importContacts } = useBackendOperation(api.contacts.contacts.importBatch, {
	label: () => t('dashboard.audience.contacts.index.operations.importContacts'),
});
const { run: createProperty } = useBackendOperation(api.contacts.properties.create, {
	label: () => t('dashboard.audience.contacts.index.operations.registerProperty'),
});

// Computed values
const isLoading = computed(() => teamLoading.value || contactsLoading.value);
const canLoadMore = computed(() => paginationStatus.value === 'CanLoadMore');
const isLoadingMore = computed(() => paginationStatus.value === 'LoadingMore');
const totalCount = computed(() => contacts.value?.length ?? 0);

const contactIds = computed(() =>
	(contacts.value ?? []).map((c: { _id: Id<'contacts'> }) => c._id)
);
const isAllPageSelected = computed(() => bulkSelection.isAllPageSelected(contactIds.value));

// Showing count text
const showingText = computed(() => {
	const count = contacts.value?.length ?? 0;
	if (count === 0) return t('dashboard.audience.contacts.index.showing.empty');
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

/** First + last for the card list, which has no room for a column each. */
const contactName = (contact: { firstName?: string | null; lastName?: string | null }) =>
	[contact.firstName, contact.lastName].filter(Boolean).join(' ');

// Right-click row menu — reuses the row's existing affordances (open + select)
// plus a native copy. No new mutation path: one action source, two entry points.
async function copyEmail(email: string) {
	try {
		await navigator.clipboard.writeText(email);
		showToast(t('dashboard.audience.contacts.index.toasts.emailCopied'), 'success');
	} catch {
		showToast(t('dashboard.audience.contacts.index.toasts.copyFailed'), 'error');
	}
}

function contactContextItems(contact: { _id: Id<'contacts'>; email?: string }): ContextMenuItem[] {
	const selected = bulkSelection.selectedIds.value.has(contact._id);
	const email = contact.email;
	const items: ContextMenuItem[] = [
		{
			id: 'open',
			label: t('dashboard.audience.contacts.index.contextMenu.open'),
			icon: 'lucide:arrow-right',
			run: () => void router.push(`/dashboard/audience/contacts/${contact._id}`),
		},
		{
			id: 'copy-email',
			label: t('dashboard.audience.contacts.index.contextMenu.copyEmail'),
			icon: 'lucide:copy',
			disabled: !email,
			run: () => {
				if (email) void copyEmail(email);
			},
		},
	];
	if (canManageContacts.value) {
		items.push({
			id: 'select',
			label: selected
				? t('dashboard.audience.contacts.index.contextMenu.deselect')
				: t('dashboard.audience.contacts.index.contextMenu.select'),
			icon: selected ? 'lucide:square' : 'lucide:check-square',
			separatorBefore: true,
			run: () => toggleContactSelection(contact._id),
		});
	}
	return items;
}

// ============================================
// Add Contact Modal
// ============================================
const addModal = useFormModal({
	email: '',
	firstName: '',
	lastName: '',
	language: '',
});

// The language catalog is module scope, so it carries message keys: the
// `{ value, label }` pairs the picker renders can only be built here, where a
// translator is in hand. Computed, so the labels follow a locale switch.
const languageChoices = computed(() => languageSelectOptions((key: string) => t(key)));

const validateAddForm = (): boolean => {
	addModal.clearErrors();
	if (!addModal.form.email.trim()) {
		addModal.errors.email = t('auth.validation.emailRequired');
		return false;
	}
	if (!isValidEmail(addModal.form.email.trim())) {
		addModal.errors.email = t('auth.validation.emailInvalid');
		return false;
	}
	return true;
};

const handleAddSubmit = async () => {
	if (!validateAddForm()) return;
	addModal.isSubmitting.value = true;

	const result = await createContact({
		email: addModal.form.email.trim(),
		firstName: addModal.form.firstName.trim() || undefined,
		lastName: addModal.form.lastName.trim() || undefined,
		language: addModal.form.language || undefined,
		source: 'form',
	});
	addModal.isSubmitting.value = false;
	if (!result.ok) return;
	showToast(
		t('dashboard.audience.contacts.index.toasts.created', { email: addModal.form.email.trim() })
	);
	addModal.close();
};

// ============================================
// CSV Import
// ============================================
const handleCsvImport = async () => {
	const results = await csvImport.startImport(
		async (contactsBatch, handleDuplicates, options) => {
			const result = await importContacts({
				contacts: contactsBatch,
				handleDuplicates,
				topicId: options?.topicId as Id<'topics'> | undefined,
				contactListAssignments: options?.contactListAssignments as
					| Array<{ email: string; topicIds: Id<'topics'>[] }>
					| undefined,
			});
			return result.ok
				? result.result
				: { imported: 0, updated: 0, skipped: 0, failed: 0, errors: [], addedToList: 0 };
		},
		// CSV is an operator import source: the backend drops property values for
		// keys that are not already registered. Register any mapped custom-column
		// keys that don't yet exist (string type — CSV cells are strings) before
		// the contact rows are imported.
		async (keys) => {
			const existing = new Set((contactProperties.value ?? []).map((p: { key: string }) => p.key));
			for (const key of keys) {
				if (existing.has(key)) continue;
				await createProperty({ key, label: key, type: 'string' });
			}
		}
	);

	if (results && (results.imported > 0 || results.updated > 0)) {
		const totalProcessed = results.imported + results.updated;
		showToast(
			t(
				'dashboard.audience.contacts.index.toasts.imported',
				{ count: totalProcessed },
				totalProcessed
			)
		);
	}
};

// ============================================
// Dropdowns and Click Outside Handlers
// ============================================
const isImportDropdownOpen = ref(false);
const importDropdownRef = ref<HTMLElement | null>(null);
const bulkActionDropdownRef = ref<HTMLElement | null>(null);

useClickOutside(importDropdownRef, () => {
	isImportDropdownOpen.value = false;
});

useClickOutside(bulkActionDropdownRef, () => {
	bulkOps.isBulkActionDropdownOpen.value = false;
	bulkOps.isAddToListDropdownOpen.value = false;
	bulkOps.isRemoveFromListDropdownOpen.value = false;
});

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
	unregisterShortcut('n');
	unregisterShortcut('escape');
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.audience.contacts.index.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">
					{{ t('dashboard.audience.contacts.index.subtitle') }}
				</p>
			</div>
			<div v-if="canManageContacts" class="flex gap-2">
				<UiButton variant="secondary" @click="isExportModalOpen = true">
					<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
					{{ t('dashboard.audience.contacts.index.export') }}
				</UiButton>
				<!-- Import Dropdown -->
				<div ref="importDropdownRef" class="relative">
					<UiButton
						variant="secondary"
						class="gap-2"
						@click.stop="isImportDropdownOpen = !isImportDropdownOpen"
					>
						<Icon name="lucide:upload" class="w-4 h-4" />
						{{ t('dashboard.audience.contacts.index.import') }}
						<Icon name="lucide:chevron-down" class="w-4 h-4" />
					</UiButton>
					<Transition
						enter-active-class="duration-(--motion-moderate) ease-spring"
						enter-from-class="opacity-0 translate-y-1"
						enter-to-class="opacity-100 translate-y-0"
						leave-active-class="duration-(--motion-moderate-exit) ease-exit"
						leave-from-class="opacity-100 translate-y-0"
						leave-to-class="opacity-0 translate-y-1"
					>
						<div
							v-if="isImportDropdownOpen"
							class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-20 py-1"
						>
							<button
								class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-3 transition-colors"
								@click="
									csvImport.open();
									isImportDropdownOpen = false;
								"
							>
								<Icon name="lucide:file-spreadsheet" class="w-4 h-4 text-brand" />
								<div>
									<p class="font-medium">
										{{ t('dashboard.audience.contacts.index.importMenu.csvTitle') }}
									</p>
									<p class="text-xs text-text-tertiary">
										{{ t('dashboard.audience.contacts.index.importMenu.csvDescription') }}
									</p>
								</div>
							</button>
							<div class="h-px bg-border-subtle my-1" />
							<button
								class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-3 transition-colors"
								@click="
									isIntegrationImportModalOpen = true;
									isImportDropdownOpen = false;
								"
							>
								<Icon name="lucide:link-2" class="w-4 h-4 text-brand" />
								<div>
									<p class="font-medium">
										{{ t('dashboard.audience.contacts.index.importMenu.integrationsTitle') }}
									</p>
									<p class="text-xs text-text-tertiary">
										{{ t('dashboard.audience.contacts.index.importMenu.integrationsDescription') }}
									</p>
								</div>
							</button>
						</div>
					</Transition>
				</div>
				<UiButton @click="addModal.open()">
					<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
					{{ t('dashboard.audience.contacts.index.addContact') }}
				</UiButton>
			</div>
		</div>

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
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="canManageContacts && bulkSelection.hasSelected.value"
					class="flex items-center gap-2"
				>
					<span class="text-sm text-text-secondary">{{
						bulkSelection.selectedCountText.value
					}}</span>

					<button
						v-if="!bulkSelection.isSelectAllMatching.value && totalCount > contacts.length"
						class="text-sm text-brand hover:underline"
						:disabled="bulkOps.isLoadingAllMatching.value"
						@click="bulkOps.selectAllMatchingFilter"
					>
						<Icon
							v-if="bulkOps.isLoadingAllMatching.value"
							name="lucide:loader-2"
							class="w-3 h-3 animate-spin inline mr-1"
						/>
						{{ t('dashboard.audience.contacts.index.selectAllMatching', { count: totalCount }) }}
					</button>

					<!-- Bulk Action Dropdown -->
					<div ref="bulkActionDropdownRef" class="relative">
						<UiButton
							variant="secondary"
							:disabled="bulkOps.isBulkOperationInProgress.value"
							@click.stop="
								bulkOps.isBulkActionDropdownOpen.value = !bulkOps.isBulkActionDropdownOpen.value
							"
						>
							<template #iconLeft><Icon name="lucide:more-horizontal" class="w-4 h-4" /></template>
							{{ t('common.actions') }}
							<template #iconRight><Icon name="lucide:chevron-down" class="w-4 h-4" /></template>
						</UiButton>

						<Transition
							enter-active-class="duration-(--motion-moderate) ease-spring"
							enter-from-class="opacity-0 translate-y-1"
							enter-to-class="opacity-100 translate-y-0"
							leave-active-class="duration-(--motion-moderate-exit) ease-exit"
							leave-from-class="opacity-100 translate-y-0"
							leave-to-class="opacity-0 translate-y-1"
						>
							<div
								v-if="bulkOps.isBulkActionDropdownOpen.value"
								class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-20 py-1"
							>
								<!-- Add to Topic submenu -->
								<div class="relative">
									<button
										class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center justify-between transition-colors"
										@click.stop="
											bulkOps.isAddToListDropdownOpen.value =
												!bulkOps.isAddToListDropdownOpen.value;
											bulkOps.isRemoveFromListDropdownOpen.value = false;
										"
									>
										<span class="flex items-center gap-2">
											<Icon name="lucide:tag" class="w-4 h-4 text-brand" />
											{{ t('dashboard.audience.contacts.index.bulk.addToTopic') }}
										</span>
										<Icon name="lucide:chevron-right" class="w-4 h-4" />
									</button>

									<Transition
										enter-active-class="duration-(--motion-moderate) ease-spring"
										enter-from-class="opacity-0 -translate-x-1"
										enter-to-class="opacity-100 translate-x-0"
										leave-active-class="duration-(--motion-moderate-exit) ease-exit"
										leave-from-class="opacity-100 translate-x-0"
										leave-to-class="opacity-0 -translate-x-1"
									>
										<div
											v-if="bulkOps.isAddToListDropdownOpen.value"
											class="absolute left-full top-0 ml-1 w-48 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg py-1 max-h-64 overflow-y-auto"
										>
											<template v-if="topics && topics.length > 0">
												<button
													v-for="list in topics"
													:key="list._id"
													class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
													@click="bulkOps.handleBulkAddToList(list._id)"
												>
													<span class="truncate">{{ list.name }}</span>
												</button>
											</template>
											<div v-else class="px-3 py-2 text-sm text-text-tertiary">
												{{ t('dashboard.audience.contacts.index.bulk.noTopics') }}
											</div>
										</div>
									</Transition>
								</div>

								<!-- Remove from Topic submenu -->
								<div class="relative">
									<button
										class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center justify-between transition-colors"
										@click.stop="
											bulkOps.isRemoveFromListDropdownOpen.value =
												!bulkOps.isRemoveFromListDropdownOpen.value;
											bulkOps.isAddToListDropdownOpen.value = false;
										"
									>
										<span class="flex items-center gap-2">
											<Icon name="lucide:list-minus" class="w-4 h-4 text-text-secondary" />
											{{ t('dashboard.audience.contacts.index.bulk.removeFromTopic') }}
										</span>
										<Icon name="lucide:chevron-right" class="w-4 h-4" />
									</button>

									<Transition
										enter-active-class="duration-(--motion-moderate) ease-spring"
										enter-from-class="opacity-0 -translate-x-1"
										enter-to-class="opacity-100 translate-x-0"
										leave-active-class="duration-(--motion-moderate-exit) ease-exit"
										leave-from-class="opacity-100 translate-x-0"
										leave-to-class="opacity-0 -translate-x-1"
									>
										<div
											v-if="bulkOps.isRemoveFromListDropdownOpen.value"
											class="absolute left-full top-0 ml-1 w-48 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg py-1 max-h-64 overflow-y-auto"
										>
											<template v-if="topics && topics.length > 0">
												<button
													v-for="list in topics"
													:key="list._id"
													class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
													@click="bulkOps.handleBulkRemoveFromList(list._id)"
												>
													<span class="truncate">{{ list.name }}</span>
												</button>
											</template>
											<div v-else class="px-3 py-2 text-sm text-text-tertiary">
												{{ t('dashboard.audience.contacts.index.bulk.noTopics') }}
											</div>
										</div>
									</Transition>
								</div>

								<div class="h-px bg-border-subtle my-1" />

								<button
									class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
									@click="bulkOps.handleBulkExport"
								>
									<Icon name="lucide:download" class="w-4 h-4 text-text-secondary" />
									{{ t('dashboard.audience.contacts.index.bulk.exportSelected') }}
								</button>

								<div class="h-px bg-border-subtle my-1" />

								<button
									class="w-full px-3 py-2 text-left text-sm text-error hover:bg-error-subtle flex items-center gap-2 transition-colors"
									@click="bulkOps.openBulkDeleteModal"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
									{{ t('dashboard.audience.contacts.index.bulk.deleteSelected') }}
								</button>
							</div>
						</Transition>
					</div>

					<button
						class="p-1.5 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="bulkSelection.clearSelection()"
						:aria-label="t('dashboard.audience.contacts.index.clearSelection')"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
			</Transition>

			<!-- Bulk Operation Progress -->
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="bulkOps.isBulkOperationInProgress.value"
					class="flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-surface"
				>
					<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin text-brand" />
					<span class="text-sm text-text-secondary">
						<template v-if="bulkOps.bulkOperationType.value === 'add'">{{
							t('dashboard.audience.contacts.index.bulk.progress.add')
						}}</template>
						<template v-else-if="bulkOps.bulkOperationType.value === 'remove'">{{
							t('dashboard.audience.contacts.index.bulk.progress.remove')
						}}</template>
						<template v-else-if="bulkOps.bulkOperationType.value === 'delete'">{{
							t('dashboard.audience.contacts.index.bulk.progress.delete')
						}}</template>
						<template v-else-if="bulkOps.bulkOperationType.value === 'export'">{{
							t('dashboard.audience.contacts.index.bulk.progress.export')
						}}</template>
					</span>
					<div class="w-20 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
						<div
							class="h-full bg-brand transition-all duration-(--motion-moderate)"
							:style="{ width: `${bulkOps.bulkOperationProgress.value}%` }"
						/>
					</div>
					<span class="text-xs text-text-tertiary">{{ bulkOps.bulkOperationProgress.value }}%</span>
				</div>
			</Transition>
		</div>

		<!-- Content -->
		<div class="card p-0 overflow-hidden">
			<UiQueryBoundary :error="contactsError">
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
				>
					<template v-if="canManageContacts" #action>
						<UiButton @click="addModal.open()">
							<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
							{{ t('dashboard.audience.contacts.index.addContact') }}
						</UiButton>
					</template>
				</UiEmptyState>

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
					<template v-if="!tableFits">
						<!-- The table's select-all sits in a `thead` the card list has no
						     room for, so bulk selection was desktop-only here. Full-width
						     row: it doubles as its own 44px touch target. -->
						<button
							v-if="canManageContacts"
							type="button"
							class="w-full flex items-center gap-3 px-4 py-3 border-b border-border-subtle text-left transition-colors hover:bg-bg-surface"
							@click="toggleSelectAll"
						>
							<span
								class="w-5 h-5 shrink-0 rounded border flex items-center justify-center transition-colors"
								:class="[
									isAllPageSelected
										? 'bg-brand border-brand text-text-inverse'
										: bulkSelection.hasSelected.value
											? 'border-brand bg-brand/20'
											: 'border-border-default',
								]"
							>
								<Icon v-if="isAllPageSelected" name="lucide:check" class="w-3 h-3" />
								<span
									v-else-if="bulkSelection.hasSelected.value"
									class="w-2 h-0.5 bg-brand rounded"
								/>
							</span>
							<span class="text-sm text-text-secondary">
								{{
									isAllPageSelected
										? t('dashboard.audience.contacts.index.deselectAll')
										: t('dashboard.audience.contacts.index.selectAll')
								}}
							</span>
						</button>
						<ul class="divide-y divide-border-subtle">
							<li
								v-for="contact in contacts"
								:key="contact._id"
								class="flex items-center gap-3 px-4 py-3 transition-colors"
								:class="bulkSelection.selectedIds.value.has(contact._id) ? 'bg-brand/5' : ''"
							>
								<button
									v-if="canManageContacts"
									class="contact-select w-5 h-5 shrink-0 rounded border flex items-center justify-center transition-colors"
									:class="[
										bulkSelection.selectedIds.value.has(contact._id)
											? 'bg-brand border-brand text-text-inverse'
											: 'border-border-default',
									]"
									:aria-label="
										bulkSelection.selectedIds.value.has(contact._id)
											? t('dashboard.audience.contacts.index.deselectContact', {
													email: contact.email,
												})
											: t('dashboard.audience.contacts.index.selectContact', {
													email: contact.email,
												})
									"
									@click="toggleContactSelection(contact._id)"
								>
									<Icon
										v-if="bulkSelection.selectedIds.value.has(contact._id)"
										name="lucide:check"
										class="w-3 h-3"
									/>
								</button>
								<button
									type="button"
									class="flex-1 min-w-0 text-left"
									@click="router.push(`/dashboard/audience/contacts/${contact._id}`)"
								>
									<span class="block text-text-primary font-medium truncate">{{
										contact.email
									}}</span>
									<span
										v-if="contactName(contact)"
										class="block text-sm text-text-secondary truncate"
									>
										{{ contactName(contact) }}
									</span>
									<span class="block text-xs text-text-tertiary mt-0.5">
										{{
											t('dashboard.audience.contacts.index.addedOn', {
												date: formatDate(contact.createdAt),
											})
										}}
									</span>
								</button>
								<Icon name="lucide:chevron-right" class="w-4 h-4 text-text-tertiary shrink-0" />
							</li>
						</ul>
					</template>

					<div v-else class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th v-if="canManageContacts" class="w-12 px-4 py-4">
										<button
											class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
											:class="[
												isAllPageSelected
													? 'bg-brand border-brand text-text-inverse'
													: bulkSelection.hasSelected.value
														? 'border-brand bg-brand/20'
														: 'border-border-default hover:border-border-strong',
											]"
											@click.stop="toggleSelectAll"
										>
											<Icon v-if="isAllPageSelected" name="lucide:check" class="w-3 h-3" />
											<div
												v-else-if="bulkSelection.hasSelected.value"
												class="w-2 h-0.5 bg-brand rounded"
											/>
										</button>
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.email') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.audience.contacts.index.table.firstName') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.audience.contacts.index.table.lastName') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										<button
											type="button"
											class="flex items-center gap-1 py-4 -my-4 px-1 -mx-1 rounded hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
											@click="toggleSort('createdAt')"
										>
											{{ t('dashboard.audience.contacts.index.table.created') }}
											<Icon
												v-if="getSortIcon('createdAt')"
												:name="getSortIcon('createdAt')!"
												class="w-4 h-4"
											/>
										</button>
									</th>
								</tr>
							</thead>
							<tbody>
								<UiContextMenu
									v-for="contact in contacts"
									:key="contact._id"
									:items="contactContextItems(contact)"
									v-slot="{ onContextmenu, onKeydown }"
								>
									<tr
										class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer"
										:class="{ 'bg-brand/5': bulkSelection.selectedIds.value.has(contact._id) }"
										@click="router.push(`/dashboard/audience/contacts/${contact._id}`)"
										@contextmenu="onContextmenu"
										@keydown="onKeydown"
									>
										<td v-if="canManageContacts" class="w-12 px-4 py-4">
											<button
												class="w-5 h-5 rounded border flex items-center justify-center transition-colors"
												:class="[
													bulkSelection.selectedIds.value.has(contact._id)
														? 'bg-brand border-brand text-text-inverse'
														: 'border-border-default hover:border-border-strong',
												]"
												@click.stop="toggleContactSelection(contact._id)"
												:aria-label="
													bulkSelection.selectedIds.value.has(contact._id)
														? t('dashboard.audience.contacts.index.deselectContact', {
																email: contact.email,
															})
														: t('dashboard.audience.contacts.index.selectContact', {
																email: contact.email,
															})
												"
											>
												<Icon
													v-if="bulkSelection.selectedIds.value.has(contact._id)"
													name="lucide:check"
													class="w-3 h-3"
												/>
											</button>
										</td>
										<td class="px-6 py-4">
											<span class="text-text-primary font-medium">{{ contact.email }}</span>
										</td>
										<td class="px-6 py-4">
											<span class="text-text-secondary">{{ contact.firstName || '-' }}</span>
										</td>
										<td class="px-6 py-4">
											<span class="text-text-secondary">{{ contact.lastName || '-' }}</span>
										</td>
										<td class="px-6 py-4">
											<span class="text-text-tertiary text-sm">{{
												formatDate(contact.createdAt)
											}}</span>
										</td>
									</tr>
								</UiContextMenu>
							</tbody>
						</table>
					</div>

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
						<span v-else-if="paginationStatus === 'Exhausted'" class="text-sm text-text-tertiary">
							{{ t('dashboard.audience.contacts.index.allLoaded') }}
						</span>
					</div>
				</div>
			</UiQueryBoundary>
		</div>

		<!-- Add Contact Modal -->
		<UiModal
			v-if="canManageContacts"
			v-model:open="addModal.isOpen.value"
			:title="t('dashboard.audience.contacts.index.addContact')"
		>
			<form @submit.prevent="handleAddSubmit">
				<div
					v-if="addModal.errors.general"
					class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20"
				>
					<p class="text-sm text-error">{{ addModal.errors.general }}</p>
				</div>
				<div class="mb-4">
					<UiInput
						v-model="addModal.form.email"
						type="email"
						:label="t('common.email')"
						:required="true"
						:placeholder="t('dashboard.audience.contacts.index.form.emailPlaceholder')"
						:error="addModal.errors.email"
						:disabled="addModal.isSubmitting.value"
					/>
				</div>
				<div class="mb-4">
					<UiInput
						v-model="addModal.form.firstName"
						:label="t('dashboard.audience.contacts.index.table.firstName')"
						:placeholder="t('dashboard.audience.contacts.index.form.firstNamePlaceholder')"
						:disabled="addModal.isSubmitting.value"
					/>
				</div>
				<div class="mb-4">
					<UiInput
						v-model="addModal.form.lastName"
						:label="t('dashboard.audience.contacts.index.table.lastName')"
						:placeholder="t('dashboard.audience.contacts.index.form.lastNamePlaceholder')"
						:disabled="addModal.isSubmitting.value"
					/>
				</div>
				<div class="mb-6">
					<UiSelect
						v-model="addModal.form.language"
						:options="languageChoices"
						:label="t('dashboard.audience.contacts.index.form.languageLabel')"
						:placeholder="t('dashboard.audience.contacts.index.form.languagePlaceholder')"
						:disabled="addModal.isSubmitting.value"
					/>
				</div>
			</form>
			<template #footer>
				<UiButton
					variant="secondary"
					:disabled="addModal.isSubmitting.value"
					@click="addModal.close()"
					>{{ t('common.cancel') }}</UiButton
				>
				<UiButton :loading="addModal.isSubmitting.value" @click="handleAddSubmit">{{
					addModal.isSubmitting.value
						? t('dashboard.audience.contacts.index.creating')
						: t('dashboard.audience.contacts.index.createContact')
				}}</UiButton>
			</template>
		</UiModal>

		<!-- CSV Import Modal -->
		<LazyContactsCsvImportModal
			v-if="canManageContacts"
			:csv-import="csvImport"
			:topics="topics"
			@import="handleCsvImport"
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

<style scoped>
/* The card list's row checkbox paints at 20px — the size the row wants — but a
 * thumb needs 44px. A transparent pseudo-element grows the hit area without
 * moving anything in the row (same trick as the recipient preferences page);
 * `z-10` keeps the overlap with the row's own tap target on the checkbox. */
.contact-select {
	position: relative;
	z-index: 10;
}

.contact-select::after {
	content: '';
	position: absolute;
	inset: -12px;
}
</style>
