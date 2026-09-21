<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.send.marketing.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();
const { isPending: authPending, isAuthenticated } = useAuth();
const router = useRouter();

// Keyboard shortcuts
const { registerNewShortcut, registerEscapeHandler, unregisterShortcut } = useKeyboardShortcuts();

// Below `md` the list view's columns can't fit, so the same rows render as a
// card list. Exactly one of the two trees is mounted: the app runs with
// `ssr: false`, so the first value is already the real one, and mounting both (a
// CSS-only `md:hidden` switch) doubles the row DOM — and, here, would give the
// two copies of every row overflow menu the same `dropdownOpenStates` entry.
const tableFits = useDataTableViewport();

// View mode and search (using useDataTable for search functionality)
const viewMode = ref<'grid' | 'list'>('grid');
const { searchQuery, debouncedSearch, clearSearch } = useDataTable({
	defaultSort: 'updatedAt',
	defaultOrder: 'desc',
});

// Sort state
type SortOption = {
	label: string;
	value: string;
	sortBy: 'updatedAt' | 'createdAt' | 'name';
	sortOrder: 'asc' | 'desc';
};

const sortOptions: SortOption[] = [
	{
		label: 'dashboard.send.marketing.index.sort.updatedDesc',
		value: 'updatedAt-desc',
		sortBy: 'updatedAt',
		sortOrder: 'desc',
	},
	{
		label: 'dashboard.send.marketing.index.sort.updatedAsc',
		value: 'updatedAt-asc',
		sortBy: 'updatedAt',
		sortOrder: 'asc',
	},
	{
		label: 'dashboard.send.marketing.index.sort.createdDesc',
		value: 'createdAt-desc',
		sortBy: 'createdAt',
		sortOrder: 'desc',
	},
	{
		label: 'dashboard.send.marketing.index.sort.createdAsc',
		value: 'createdAt-asc',
		sortBy: 'createdAt',
		sortOrder: 'asc',
	},
	{
		label: 'dashboard.send.marketing.index.sort.nameAsc',
		value: 'name-asc',
		sortBy: 'name',
		sortOrder: 'asc',
	},
	{
		label: 'dashboard.send.marketing.index.sort.nameDesc',
		value: 'name-desc',
		sortBy: 'name',
		sortOrder: 'desc',
	},
];

const currentSort = ref<SortOption>(sortOptions[0]!);
const isSortDropdownOpen = ref(false);

const selectSort = (option: SortOption) => {
	currentSort.value = option;
	isSortDropdownOpen.value = false;
};

// Fetch marketing templates. Type filter + full-text search run server-side
// through the Listing engine (ADR-0037); the sort dropdown is applied
// client-side over the loaded page. Search results keep relevance order.
const {
	results: rawTemplates,
	isLoading: templatesLoading,
	error: templatesError,
} = usePaginatedQuery(
	api.emailTemplates.emails.list,
	() => {
		if (authPending.value || !isAuthenticated.value) return 'skip';
		return {
			type: 'marketing' as const,
			search: debouncedSearch.value || undefined,
		};
	},
	{ initialNumItems: 100 }
);

const templates = computed(() => {
	// During a search the engine returns relevance order — leave it untouched.
	if (debouncedSearch.value) return rawTemplates.value;
	const { sortBy, sortOrder } = currentSort.value;
	return [...rawTemplates.value].sort((a, b) => {
		let cmp = 0;
		if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
		else if (sortBy === 'createdAt') cmp = a.createdAt - b.createdAt;
		else cmp = a.updatedAt - b.updatedAt;
		return sortOrder === 'desc' ? -cmp : cmp;
	});
});

// Fetch template counts
const { data: typeCounts } = useOrganizationQuery(
	api.emailTemplates.organization.countByTypeByOrganization
);

const isLoading = computed(() => teamLoading.value || templatesLoading.value);

// Mutations
const { run: duplicateTemplate } = useBackendOperation(api.emailTemplates.emails.duplicate, {
	label: () => t('dashboard.send.marketing.index.operations.duplicate'),
});
const { run: deleteTemplate } = useBackendOperation(api.emailTemplates.emails.remove, {
	label: () => t('dashboard.send.marketing.index.operations.delete'),
});
const { run: createTemplate } = useBackendOperation(api.emailTemplates.emails.create, {
	label: () => t('dashboard.send.marketing.index.operations.create'),
});
const { run: createFromPreset } = useBackendOperation(
	api.emailTemplates.organization.createFromPreset,
	{ label: () => t('dashboard.send.marketing.index.operations.create') }
);

// Toast notifications
const { showToast } = useToast();

// Get status badge
const getStatusBadge = (status: 'draft' | 'published') => {
	return status === 'published'
		? {
				color: 'bg-success/10 text-success',
				label: t('dashboard.send.marketing.index.status.published'),
			}
		: {
				color: 'bg-text-tertiary/10 text-text-tertiary',
				label: t('dashboard.send.marketing.index.status.draft'),
			};
};

// Action dropdown state
const dropdownOpenStates = reactive<Record<string, boolean>>({});

// Handle duplicate
const handleDuplicate = async (templateId: Id<'emailTemplates'>) => {
	const result = await duplicateTemplate({ templateId });
	if (!result.ok) return;
	showToast(t('dashboard.send.marketing.index.toasts.duplicated'));
};

// Delete confirmation modal
const isDeleteModalOpen = ref(false);
const templateToDelete = ref<{ id: Id<'emailTemplates'>; name: string } | null>(null);
const isDeleting = ref(false);

const openDeleteModal = (id: Id<'emailTemplates'>, name: string) => {
	templateToDelete.value = { id, name };
	isDeleteModalOpen.value = true;
};

const closeDeleteModal = () => {
	isDeleteModalOpen.value = false;
	templateToDelete.value = null;
};

const handleDelete = async () => {
	if (!templateToDelete.value) return;

	isDeleting.value = true;
	try {
		const result = await deleteTemplate({ templateId: templateToDelete.value.id });
		if (!result.ok) return;
		showToast(t('dashboard.send.marketing.index.toasts.deleted'));
		closeDeleteModal();
	} finally {
		isDeleting.value = false;
	}
};

// Template library modal
const isTemplateLibraryOpen = ref(false);
const templateLibraryRef = ref<{
	handleCreate: (
		createTemplate: (args: {
			name: string;
			type: 'marketing' | 'transactional';
		}) => Promise<BackendOperationResult<Id<'emailTemplates'>>>,
		createFromPreset: (args: {
			name: string;
			subject: string;
			content: string;
			type: 'marketing' | 'transactional';
		}) => Promise<BackendOperationResult<Id<'emailTemplates'>>>
	) => Promise<void>;
	templateName: string;
	isCreating: boolean;
} | null>(null);

const openCreateModal = () => {
	isTemplateLibraryOpen.value = true;
};

const handleTemplateCreate = (templateId: Id<'emailTemplates'>) => {
	router.push(`/dashboard/send/emails/${templateId}/edit`);
};

const handleCreateSubmit = async () => {
	await templateLibraryRef.value?.handleCreate(createTemplate, createFromPreset);
};

// Navigate to edit
const handleEdit = (templateId: Id<'emailTemplates'>) => {
	router.push(`/dashboard/send/emails/${templateId}/edit`);
};

// Close sort dropdown when clicking outside
useClickOutsideSelector('[data-sort-dropdown]', () => {
	isSortDropdownOpen.value = false;
});

// Keyboard shortcuts setup
onMounted(() => {
	registerNewShortcut(() => {
		if (!isTemplateLibraryOpen.value && !isDeleteModalOpen.value) {
			openCreateModal();
		}
	});

	registerEscapeHandler(() => {
		if (isTemplateLibraryOpen.value && !templateLibraryRef.value?.isCreating) {
			isTemplateLibraryOpen.value = false;
		} else if (isDeleteModalOpen.value && !isDeleting.value) {
			closeDeleteModal();
		}
	});
});

onUnmounted(() => {
	unregisterShortcut('global.newItem');
	unregisterShortcut('global.close');
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.send.marketing.index.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">
					{{ t('dashboard.send.marketing.index.subtitle') }}
				</p>
			</div>
			<UiButton size="sm" @click="openCreateModal">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('dashboard.send.marketing.index.newTemplate') }}
			</UiButton>
		</div>

		<!-- Stats and Search -->
		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<div v-if="typeCounts" class="text-sm text-text-secondary">
				{{
					t(
						'dashboard.send.marketing.index.templateCount',
						{ count: typeCounts['marketing'] },
						typeCounts['marketing'] ?? 0
					)
				}}
			</div>

			<div class="flex-1" />

			<div class="flex items-center gap-3">
				<UiInput
					v-model="searchQuery"
					type="text"
					:placeholder="t('dashboard.send.marketing.index.searchPlaceholder')"
					size="sm"
					class="w-64"
				>
					<template #iconLeft>
						<Icon name="lucide:search" class="w-4 h-4 text-text-tertiary" />
					</template>
				</UiInput>

				<!-- Sort Dropdown -->
				<div class="relative" data-sort-dropdown>
					<UiButton
						variant="outline"
						size="sm"
						aria-haspopup="listbox"
						:aria-expanded="isSortDropdownOpen"
						aria-controls="marketing-sort-listbox"
						:aria-label="t('dashboard.send.marketing.index.sortLabel')"
						@click="isSortDropdownOpen = !isSortDropdownOpen"
					>
						<template #iconLeft>
							<Icon name="lucide:arrow-up-down" class="w-4 h-4" />
						</template>
						<span class="hidden sm:inline">{{ t(currentSort.label) }}</span>
						<template #iconRight>
							<Icon name="lucide:chevron-down" class="w-4 h-4" />
						</template>
					</UiButton>
					<Transition
						enter-active-class="duration-(--motion-moderate) ease-spring"
						enter-from-class="opacity-0 scale-95"
						enter-to-class="opacity-100 scale-100"
						leave-active-class="duration-(--motion-moderate-exit) ease-exit"
						leave-from-class="opacity-100 scale-100"
						leave-to-class="opacity-0 scale-95"
					>
						<div
							v-if="isSortDropdownOpen"
							id="marketing-sort-listbox"
							role="listbox"
							:aria-label="t('dashboard.send.marketing.index.sortLabel')"
							class="absolute right-0 top-full mt-1 w-44 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-20 py-1"
						>
							<button
								v-for="option in sortOptions"
								:key="option.value"
								role="option"
								:aria-selected="currentSort.value === option.value"
								:class="[
									'w-full px-3 py-2 text-left text-sm transition-colors flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset',
									currentSort.value === option.value
										? 'text-brand bg-brand/5'
										: 'text-text-primary hover:bg-bg-surface',
								]"
								@click="selectSort(option)"
							>
								{{ t(option.label) }}
								<Icon
									v-if="currentSort.value === option.value"
									name="lucide:check"
									class="w-4 h-4"
								/>
							</button>
						</div>
					</Transition>
				</div>

				<!-- View Mode Toggle -->
				<div class="flex items-center gap-1 p-1 bg-bg-surface rounded-lg">
					<button
						:class="[
							'p-2 rounded-md transition-colors',
							viewMode === 'grid'
								? 'bg-bg-elevated text-text-primary shadow-sm'
								: 'text-text-tertiary hover:text-text-primary',
						]"
						@click="viewMode = 'grid'"
						:aria-label="t('dashboard.send.marketing.index.gridView')"
					>
						<Icon name="lucide:grid-3x3" class="w-4 h-4" />
					</button>
					<button
						:class="[
							'p-2 rounded-md transition-colors',
							viewMode === 'list'
								? 'bg-bg-elevated text-text-primary shadow-sm'
								: 'text-text-tertiary hover:text-text-primary',
						]"
						@click="viewMode = 'list'"
						:aria-label="t('dashboard.send.marketing.index.listView')"
					>
						<Icon name="lucide:list" class="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>

		<!-- Content -->
		<div>
			<UiQueryBoundary
				:loading="isLoading && !templates"
				:error="templatesError"
				:error-title="t('dashboard.send.marketing.index.loadError')"
				:loading-label="t('dashboard.send.marketing.index.loadingTemplates')"
			>
				<!-- Empty State (no team) -->
				<UiEmptyState
					v-if="!hasActiveOrganization"
					icon="lucide:mail"
					:title="t('dashboard.send.marketing.index.emptyNoTeam.title')"
					:description="t('dashboard.send.marketing.index.emptyNoTeam.description')"
				/>

				<!-- Empty State (no templates) -->
				<UiEmptyState
					v-else-if="!isLoading && (!templates || templates.length === 0) && !debouncedSearch"
					icon="lucide:megaphone"
					:title="t('dashboard.send.marketing.index.empty.title')"
					:description="t('dashboard.send.marketing.index.empty.description')"
				>
					<template #action>
						<UiButton @click="openCreateModal">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							{{ t('dashboard.send.marketing.index.empty.action') }}
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty State (no search results) -->
				<UiEmptyState
					v-else-if="!isLoading && (!templates || templates.length === 0) && debouncedSearch"
					icon="lucide:search"
					:title="t('dashboard.send.marketing.index.noResults.title')"
					:description="
						t('dashboard.send.marketing.index.noResults.description', { query: debouncedSearch })
					"
				>
					<template #action>
						<UiButton variant="secondary" @click="clearSearch()">
							{{ t('dashboard.send.marketing.index.clearSearch') }}
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Grid View -->
				<div
					v-else-if="viewMode === 'grid'"
					class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
				>
					<UiCard
						v-for="template in templates"
						:key="template._id"
						padding="none"
						overflow="hidden"
						hoverable
						clickable
						class="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						role="button"
						tabindex="0"
						:aria-label="t('dashboard.send.marketing.index.editAriaLabel', { name: template.name })"
						@click="handleEdit(template._id)"
						@keydown.enter.self="handleEdit(template._id)"
						@keydown.space.self.prevent="handleEdit(template._id)"
					>
						<!-- Thumbnail Area -->
						<div class="aspect-[4/3] bg-bg-surface flex items-center justify-center relative">
							<Icon name="lucide:send" class="w-12 h-12 text-text-tertiary/30" />
							<!-- Hover Overlay -->
							<div
								class="absolute inset-0 bg-bg-deep/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2"
							>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click.stop="handleEdit(template._id)"
									:aria-label="t('common.edit')"
								>
									<Icon name="lucide:pencil" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click.stop="handleDuplicate(template._id)"
									:aria-label="t('common.copy')"
								>
									<Icon name="lucide:copy" class="w-4 h-4" />
								</button>
								<button
									class="p-2 rounded-lg bg-bg-elevated text-text-primary hover:bg-error hover:text-text-inverse transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									@click.stop="openDeleteModal(template._id, template.name)"
									:aria-label="t('common.delete')"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							</div>
						</div>

						<!-- Info -->
						<div class="p-4">
							<div class="flex items-start justify-between gap-2">
								<div class="min-w-0 flex-1">
									<h3 class="font-medium text-text-primary truncate">{{ template.name }}</h3>
									<p class="text-sm text-text-tertiary truncate mt-0.5">
										{{ template.subject || t('dashboard.send.marketing.index.noSubject') }}
									</p>
								</div>
								<UiDropdownMenu v-model:open="dropdownOpenStates[template._id]" @click.stop>
									<template #trigger>
										<UiButton variant="ghost" size="sm">
											<Icon name="lucide:more-vertical" class="w-4 h-4" />
										</UiButton>
									</template>
									<UiDropdownMenuItem icon="lucide:pencil" @click="handleEdit(template._id)">
										{{ t('common.edit') }}
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:copy" @click="handleDuplicate(template._id)">
										{{ t('common.duplicate') }}
									</UiDropdownMenuItem>
									<UiDropdownDivider />
									<UiDropdownMenuItem
										icon="lucide:trash-2"
										danger
										@click="openDeleteModal(template._id, template.name)"
									>
										{{ t('common.delete') }}
									</UiDropdownMenuItem>
								</UiDropdownMenu>
							</div>

							<div class="flex items-center gap-2 mt-3">
								<span
									:class="[
										'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
										getStatusBadge(template.status).color,
									]"
								>
									{{ getStatusBadge(template.status).label }}
								</span>
							</div>

							<p class="text-xs text-text-tertiary mt-3">
								{{
									t('dashboard.send.marketing.index.updatedAt', {
										date: formatDate(template.updatedAt, 'medium', locale),
									})
								}}
							</p>
						</div>
					</UiCard>
				</div>

				<!-- List View -->
				<UiCard v-else padding="none" overflow="hidden">
					<!-- Below md the columns can't fit — the same rows become a card
					     list, with the row actions folded into the overflow menu. -->
					<ul v-if="!tableFits" class="divide-y divide-border-subtle">
						<li v-for="template in templates" :key="template._id">
							<div class="flex items-start gap-3 px-4 py-3">
								<button
									type="button"
									class="flex-1 min-w-0 text-left"
									:aria-label="
										t('dashboard.send.marketing.index.editAriaLabel', { name: template.name })
									"
									@click="handleEdit(template._id)"
								>
									<span class="block text-text-primary font-medium truncate">{{
										template.name
									}}</span>
									<span class="block text-sm text-text-secondary truncate">
										{{ template.subject || t('dashboard.send.marketing.index.noSubject') }}
									</span>
									<span class="flex items-center gap-2 mt-1.5">
										<span
											:class="[
												'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
												getStatusBadge(template.status).color,
											]"
										>
											{{ getStatusBadge(template.status).label }}
										</span>
										<span class="text-xs text-text-tertiary">
											{{
												t('dashboard.send.marketing.index.updatedAt', {
													date: formatDate(template.updatedAt, 'medium', locale),
												})
											}}
										</span>
									</span>
								</button>
								<UiDropdownMenu v-model:open="dropdownOpenStates[template._id]">
									<template #trigger>
										<UiButton
											variant="ghost"
											size="sm"
											:aria-label="t('dashboard.send.marketing.index.rowActions')"
										>
											<Icon name="lucide:more-vertical" class="w-4 h-4" />
										</UiButton>
									</template>
									<UiDropdownMenuItem icon="lucide:pencil" @click="handleEdit(template._id)">
										{{ t('common.edit') }}
									</UiDropdownMenuItem>
									<UiDropdownMenuItem icon="lucide:copy" @click="handleDuplicate(template._id)">
										{{ t('common.duplicate') }}
									</UiDropdownMenuItem>
									<UiDropdownDivider />
									<UiDropdownMenuItem
										icon="lucide:trash-2"
										danger
										@click="openDeleteModal(template._id, template.name)"
									>
										{{ t('common.delete') }}
									</UiDropdownMenuItem>
								</UiDropdownMenu>
							</div>
						</li>
					</ul>

					<div v-else class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.name') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.send.marketing.index.columns.subject') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.status') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.send.marketing.index.columns.updated') }}
									</th>
									<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.actions') }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="template in templates"
									:key="template._id"
									class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
									role="button"
									tabindex="0"
									:aria-label="
										t('dashboard.send.marketing.index.editAriaLabel', { name: template.name })
									"
									@click="handleEdit(template._id)"
									@keydown.enter.self="handleEdit(template._id)"
									@keydown.space.self.prevent="handleEdit(template._id)"
								>
									<td class="px-6 py-4">
										<span class="text-text-primary font-medium">{{ template.name }}</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-secondary">{{ template.subject || '-' }}</span>
									</td>
									<td class="px-6 py-4">
										<span
											:class="[
												'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium',
												getStatusBadge(template.status).color,
											]"
										>
											{{ getStatusBadge(template.status).label }}
										</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-tertiary text-sm">{{
											formatDate(template.updatedAt)
										}}</span>
									</td>
									<td class="px-6 py-4">
										<div class="flex items-center justify-end gap-1" @click.stop>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												@click="handleEdit(template._id)"
												:aria-label="t('common.edit')"
											>
												<Icon name="lucide:pencil" class="w-4 h-4" />
											</button>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												@click="handleDuplicate(template._id)"
												:aria-label="t('common.copy')"
											>
												<Icon name="lucide:copy" class="w-4 h-4" />
											</button>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												@click="openDeleteModal(template._id, template.name)"
												:aria-label="t('common.delete')"
											>
												<Icon name="lucide:trash-2" class="w-4 h-4" />
											</button>
										</div>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</UiCard>
			</UiQueryBoundary>
		</div>

		<!-- Template Library Modal -->
		<LazyMailTemplateLibraryModal
			ref="templateLibraryRef"
			v-model:open="isTemplateLibraryOpen"
			@create="handleTemplateCreate"
		>
			<template #submit-button="{ isCreating }">
				<UiButton type="submit" :loading="isCreating" @click="handleCreateSubmit">
					{{
						isCreating
							? t('dashboard.send.marketing.index.creating')
							: t('dashboard.send.marketing.index.createAndEdit')
					}}
				</UiButton>
			</template>
		</LazyMailTemplateLibraryModal>

		<!-- Delete Confirmation Modal -->
		<UiModal
			v-model:open="isDeleteModalOpen"
			:title="t('dashboard.send.marketing.index.delete.title')"
			:persistent="isDeleting"
		>
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error/10 shrink-0 flex items-center justify-center">
					<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
				</div>
				<div>
					<I18nT
						keypath="dashboard.send.marketing.index.delete.confirm"
						tag="p"
						class="text-text-primary"
						scope="global"
					>
						<template #name>
							<span class="font-semibold">"{{ templateToDelete?.name }}"</span>
						</template>
					</I18nT>
					<p class="text-sm text-text-secondary mt-2">
						{{ t('dashboard.send.marketing.index.delete.description') }}
					</p>
				</div>
			</div>

			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					{{
						isDeleting
							? t('dashboard.send.marketing.index.delete.deleting')
							: t('dashboard.send.marketing.index.delete.confirmButton')
					}}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
