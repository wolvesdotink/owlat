<script setup lang="ts">
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import type { Condition } from '~/composables/conditions';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.audience.segments.index.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: 'auth' });

// ─── Organization & Data ───────────────────────────────────────────────
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();
const {
	results: segments,
	isLoading: segmentsLoading,
	status: segmentsStatus,
	loadMore: loadMoreSegments,
	error: segmentsError,
} = usePaginatedQuery(api.segments.list, () => ({}), { initialNumItems: 100 });
// The list filters/sorts client-side with no pager, so an org with >100
// segments was silently capped at the first 100. Eagerly pull every page.
watch(
	segmentsStatus,
	(s) => {
		if (s === 'CanLoadMore') loadMoreSegments(100);
	},
	{ immediate: true }
);
const { results: topics } = useTopicsList();
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);
const isLoading = computed(() => organizationLoading.value || segmentsLoading.value);

// ─── Composables ───────────────────────────────────────────────────────
const {
	describeFilters,
	addCondition: addFilterCondition,
	removeCondition: removeFilterCondition,
} = useSegmentFilters({ contactProperties, topics });

const {
	isSegmentModalOpen,
	isEditMode,
	segmentForm,
	segmentErrors,
	isSaving,
	isSegmentFormDirty,
	matchingCount,
	countLoading,
	openCreateModal,
	openEditModal,
	closeSegmentModal,
	handleSave,
	isDeleteModalOpen,
	deleteTarget,
	isDeleting,
	openDeleteModal,
	closeDeleteModal,
	handleDelete,
} = useSegmentForm();

// ─── Search & Sort ─────────────────────────────────────────────────────
// Shared contract with the other audience list pages: identical debounced
// search + sort affordance, sortable columns declared in one place.
type SortField = 'name' | 'cachedCount' | 'createdAt';
const { searchQuery, debouncedSearch, sortBy, sortOrder, toggleSort, getSortIcon } =
	useDataTable<SortField>({
		defaultSort: 'createdAt',
		defaultOrder: 'desc',
		sortableFields: ['name', 'cachedCount', 'createdAt'],
	});

const filteredSegments = computed(() => {
	if (!segments.value) return [];

	let list = [...segments.value];

	if (debouncedSearch.value) {
		const query = debouncedSearch.value.toLowerCase();
		list = list.filter(
			(segment) =>
				segment.name.toLowerCase().includes(query) ||
				(segment.description && segment.description.toLowerCase().includes(query))
		);
	}

	list.sort((a, b) => {
		let comparison = 0;
		if (sortBy.value === 'name') {
			comparison = a.name.localeCompare(b.name);
		} else if (sortBy.value === 'cachedCount') {
			comparison = (a.cachedCount || 0) - (b.cachedCount || 0);
		} else if (sortBy.value === 'createdAt') {
			comparison = a.createdAt - b.createdAt;
		}
		return sortOrder.value === 'asc' ? comparison : -comparison;
	});

	return list;
});

// ─── Condition Helpers (bind filter operations to the form) ────────────
const addCondition = () => addFilterCondition(segmentForm.filters);
const removeCondition = (i: number) => removeFilterCondition(segmentForm.filters, i);
const updateConditionAt = (i: number, next: Condition) => {
	segmentForm.filters.conditions.splice(i, 1, next);
};

// Unsaved-changes guard for the builder modal. Dismissing via the backdrop or
// the X while the form has edits prompts to save/discard instead of silently
// dropping the segment being built. Reuses the shared UnsavedChangesDialog.
const showSegmentDiscardDialog = ref(false);
const requestCloseSegmentModal = () => {
	if (isSegmentFormDirty.value) {
		showSegmentDiscardDialog.value = true;
		return;
	}
	closeSegmentModal();
};
const discardSegmentEdits = () => {
	showSegmentDiscardDialog.value = false;
	closeSegmentModal();
};
const saveSegmentEdits = async () => {
	showSegmentDiscardDialog.value = false;
	// handleSave validates and closes the modal on success; it keeps the modal
	// open (with inline errors) when the form is invalid.
	await handleSave();
};

// Auto-open the Create Segment modal when arriving via the audience overview
// quick-action link (/dashboard/audience/segments?action=create).
const route = useRoute();
onMounted(() => {
	if (route.query['action'] === 'create') {
		openCreateModal();
	}
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.audience.segments.index.title') }}
				</h1>
				<p class="mt-1 text-text-secondary">
					{{ t('dashboard.audience.segments.index.subtitle') }}
				</p>
			</div>
			<UiButton @click="openCreateModal">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				{{ t('dashboard.audience.segments.index.newSegment') }}
			</UiButton>
		</div>

		<!-- Search Bar -->
		<div class="mb-6 max-w-md">
			<UiInput
				v-model="searchQuery"
				:placeholder="t('dashboard.audience.segments.index.searchPlaceholder')"
			>
				<template #iconLeft><Icon name="lucide:search" /></template>
			</UiInput>
		</div>

		<!-- Content -->
		<UiCard padding="none" overflow="hidden">
			<UiQueryBoundary
				:loading="isLoading && segments.length === 0"
				:error="segmentsError"
				:error-title="t('dashboard.audience.segments.index.errorTitle')"
			>
				<!-- Loading State: content-shaped skeleton on first load only -->
				<template #loading>
					<DashboardListSkeleton variant="table" :columns="6" :rows="6" />
				</template>

				<!-- Empty State (no organization) -->
				<UiEmptyState
					v-if="!hasActiveOrganization"
					icon="lucide:filter"
					:title="t('dashboard.audience.segments.index.noWorkspace.title')"
					:description="t('dashboard.audience.segments.index.noWorkspace.description')"
				/>

				<!-- Empty State (no segments) -->
				<UiEmptyState
					v-else-if="!isLoading && filteredSegments.length === 0 && !searchQuery"
					icon="lucide:filter"
					:title="t('dashboard.audience.segments.index.empty.title')"
					:description="t('dashboard.audience.segments.index.empty.description')"
				>
					<template #action>
						<UiButton @click="openCreateModal">
							<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
							{{ t('dashboard.audience.segments.index.newSegment') }}
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty State (no search results) -->
				<UiEmptyState
					v-else-if="!isLoading && filteredSegments.length === 0 && searchQuery"
					icon="lucide:search"
					:title="t('dashboard.audience.segments.index.noResults.title')"
					:description="
						t('dashboard.audience.segments.index.noResults.description', { query: searchQuery })
					"
				>
					<template #action>
						<UiButton variant="secondary" @click="searchQuery = ''">{{
							t('dashboard.audience.segments.index.clearSearch')
						}}</UiButton>
					</template>
				</UiEmptyState>

				<!-- Data Table -->
				<div v-else>
					<div class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										<button
											type="button"
											class="flex items-center gap-1 py-4 -my-4 px-1 -mx-1 rounded hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
											@click="toggleSort('name')"
										>
											{{ t('common.name') }}
											<Icon
												v-if="getSortIcon('name')"
												:name="getSortIcon('name')!"
												class="w-4 h-4"
											/>
										</button>
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('dashboard.audience.segments.index.table.filters') }}
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										<button
											type="button"
											class="flex items-center gap-1 py-4 -my-4 px-1 -mx-1 rounded hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
											@click="toggleSort('cachedCount')"
										>
											{{ t('dashboard.audience.segments.index.table.contacts') }}
											<Icon
												v-if="getSortIcon('cachedCount')"
												:name="getSortIcon('cachedCount')!"
												class="w-4 h-4"
											/>
										</button>
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										<button
											type="button"
											class="flex items-center gap-1 py-4 -my-4 px-1 -mx-1 rounded hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
											@click="toggleSort('createdAt')"
										>
											{{ t('dashboard.audience.segments.index.table.created') }}
											<Icon
												v-if="getSortIcon('createdAt')"
												:name="getSortIcon('createdAt')!"
												class="w-4 h-4"
											/>
										</button>
									</th>
									<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.actions') }}
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="segment in filteredSegments"
									:key="segment._id"
									class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors"
								>
									<td class="px-6 py-4">
										<NuxtLink
											:to="`/dashboard/audience/segments/${segment._id}`"
											class="flex items-center gap-3 group"
										>
											<UiIconBox icon="lucide:filter" size="sm" variant="surface" rounded="lg" />
											<div>
												<span
													class="text-text-primary font-medium group-hover:text-brand transition-colors"
													>{{ segment.name }}</span
												>
												<p v-if="segment.description" class="text-sm text-text-tertiary">
													{{ segment.description }}
												</p>
											</div>
										</NuxtLink>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-secondary text-sm">{{
											describeFilters(segment.filters)
										}}</span>
									</td>
									<td class="px-6 py-4">
										<div class="flex items-center gap-2">
											<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
											<span class="text-text-secondary">{{ segment.cachedCount ?? '—' }}</span>
										</div>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-tertiary text-sm">{{
											formatDate(segment.createdAt)
										}}</span>
									</td>
									<td class="px-6 py-4">
										<div class="flex items-center justify-end gap-1">
											<NuxtLink
												:to="`/dashboard/audience/segments/${segment._id}`"
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												:title="t('dashboard.audience.segments.index.actions.viewContacts')"
											>
												<Icon name="lucide:users" class="w-4 h-4" />
											</NuxtLink>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												:title="t('dashboard.audience.segments.index.actions.edit')"
												@click="openEditModal(segment)"
											>
												<Icon name="lucide:pencil" class="w-4 h-4" />
											</button>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
												:title="t('dashboard.audience.segments.index.actions.delete')"
												@click="openDeleteModal(segment)"
											>
												<Icon name="lucide:trash-2" class="w-4 h-4" />
											</button>
										</div>
									</td>
								</tr>
							</tbody>
						</table>
					</div>

					<!-- Segment count footer -->
					<div class="px-6 py-4 border-t border-border-subtle">
						<p class="text-sm text-text-tertiary">
							{{
								t(
									'dashboard.audience.segments.index.count',
									{ count: filteredSegments.length },
									filteredSegments.length
								)
							}}
						</p>
					</div>
				</div>
			</UiQueryBoundary>
		</UiCard>

		<!-- Create/Edit Segment Modal -->
		<UiModal
			:open="isSegmentModalOpen"
			:title="
				isEditMode
					? t('dashboard.audience.segments.index.modal.editTitle')
					: t('dashboard.audience.segments.index.modal.createTitle')
			"
			size="2xl"
			:closable="!isSaving"
			:persistent="isSaving"
			@update:open="
				(v) => {
					if (!v) requestCloseSegmentModal();
				}
			"
		>
			<!-- Form -->
			<form id="segment-form" @submit.prevent="handleSave">
				<!-- General Error -->
				<div
					v-if="segmentErrors.general"
					class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20"
				>
					<p class="text-sm text-error">{{ segmentErrors.general }}</p>
				</div>

				<!-- Name Field -->
				<div class="mb-4">
					<label for="segment-name" class="label">
						{{ t('common.name') }} <span class="text-error">*</span>
					</label>
					<input
						id="segment-name"
						v-model="segmentForm.name"
						type="text"
						:placeholder="t('dashboard.audience.segments.index.modal.namePlaceholder')"
						:class="['input', segmentErrors.name ? 'input-error' : '']"
						:disabled="isSaving"
					/>
					<p v-if="segmentErrors.name" class="error-message">
						{{ segmentErrors.name }}
					</p>
				</div>

				<!-- Description Field -->
				<div class="mb-6">
					<label for="segment-description" class="label">{{ t('common.description') }}</label>
					<textarea
						id="segment-description"
						v-model="segmentForm.description"
						rows="2"
						:placeholder="t('dashboard.audience.segments.index.modal.descriptionPlaceholder')"
						class="input resize-none"
						:disabled="isSaving"
					/>
				</div>

				<!-- Filter Logic -->
				<div class="mb-4">
					<label class="label">{{ t('dashboard.audience.segments.index.modal.matchLabel') }}</label>
					<div class="flex gap-2">
						<button
							type="button"
							:class="[
								'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
								segmentForm.filters.logic === 'AND'
									? 'bg-text-primary text-text-inverse'
									: 'bg-bg-surface text-text-secondary hover:text-text-primary',
							]"
							@click="segmentForm.filters.logic = 'AND'"
						>
							{{ t('dashboard.audience.segments.index.modal.logicAnd') }}
						</button>
						<button
							type="button"
							:class="[
								'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
								segmentForm.filters.logic === 'OR'
									? 'bg-text-primary text-text-inverse'
									: 'bg-bg-surface text-text-secondary hover:text-text-primary',
							]"
							@click="segmentForm.filters.logic = 'OR'"
						>
							{{ t('dashboard.audience.segments.index.modal.logicOr') }}
						</button>
					</div>
				</div>

				<!-- Conditions -->
				<div class="mb-6">
					<div class="flex items-center justify-between mb-3">
						<label class="label mb-0">{{
							t('dashboard.audience.segments.index.modal.conditions')
						}}</label>
						<UiButton
							variant="secondary"
							size="sm"
							type="button"
							class="gap-1"
							@click="addCondition"
						>
							<Icon name="lucide:plus" class="w-3 h-3" />
							{{ t('dashboard.audience.segments.index.modal.addCondition') }}
						</UiButton>
					</div>

					<!-- Conditions Error -->
					<div
						v-if="segmentErrors.conditions"
						class="mb-3 p-3 rounded-lg bg-error-subtle border border-error/20"
					>
						<p class="text-sm text-error">{{ segmentErrors.conditions }}</p>
					</div>

					<!-- Empty state -->
					<div
						v-if="segmentForm.filters.conditions.length === 0"
						class="p-8 border-2 border-dashed border-border-subtle rounded-xl text-center"
					>
						<Icon name="lucide:filter" class="w-8 h-8 text-text-tertiary mx-auto mb-2" />
						<p class="text-text-secondary text-sm">
							{{ t('dashboard.audience.segments.index.modal.noConditions') }}
						</p>
						<p class="text-text-tertiary text-xs mt-1">
							{{ t('dashboard.audience.segments.index.modal.noConditionsHint') }}
						</p>
					</div>

					<!-- Condition rows -->
					<div class="space-y-3">
						<div
							v-for="(condition, index) in segmentForm.filters.conditions"
							:key="index"
							class="p-4 bg-bg-surface rounded-xl border border-border-subtle"
						>
							<div class="flex items-start gap-3">
								<!-- Condition number -->
								<div
									class="shrink-0 w-6 h-6 rounded-full bg-bg-elevated text-text-tertiary text-xs flex items-center justify-center"
								>
									{{ index + 1 }}
								</div>

								<!-- Condition fields (per-kind editor via the Condition editor module) -->
								<div class="flex-1 space-y-3">
									<ConditionsConditionEditor
										:model-value="condition"
										variant="row"
										@update:model-value="updateConditionAt(index, $event)"
									/>
								</div>

								<!-- Remove button -->
								<button
									type="button"
									class="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
									:title="t('dashboard.audience.segments.index.modal.removeCondition')"
									@click="removeCondition(index)"
								>
									<Icon name="lucide:x" class="w-4 h-4" />
								</button>
							</div>
						</div>
					</div>
				</div>

				<!-- Matching contacts count -->
				<div class="mb-6 p-4 bg-bg-surface rounded-xl border border-border-subtle">
					<div class="flex items-center gap-3">
						<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
							<Icon name="lucide:users" class="w-5 h-5 text-brand" />
						</div>
						<div>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.audience.segments.index.modal.matchingContacts') }}
							</p>
							<p class="text-xl font-semibold text-text-primary">
								<template v-if="countLoading">
									<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin inline" />
								</template>
								<template v-else>
									{{ matchingCount?.toLocaleString(locale) ?? 0 }}
								</template>
							</p>
						</div>
					</div>
				</div>
			</form>

			<!-- Footer Actions -->
			<template #footer>
				<UiButton variant="secondary" :disabled="isSaving" @click="closeSegmentModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="submit" form="segment-form" :loading="isSaving">
					{{
						isSaving
							? t('common.saving')
							: isEditMode
								? t('dashboard.audience.segments.index.modal.saveChanges')
								: t('dashboard.audience.segments.index.modal.createTitle')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiModal
			v-model:open="isDeleteModalOpen"
			:title="t('dashboard.audience.segments.index.deleteDialog.title')"
		>
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error-subtle flex items-center justify-center">
					<Icon name="lucide:alert-triangle" class="w-6 h-6 text-error" />
				</div>
				<div>
					<p class="text-text-primary font-medium">
						{{
							t('dashboard.audience.segments.index.deleteDialog.body', {
								name: deleteTarget?.name ?? '',
							})
						}}
					</p>
					<p class="text-sm text-text-secondary mt-1">
						{{ t('dashboard.audience.segments.index.deleteDialog.note') }}
					</p>
				</div>
			</div>
			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					<template v-if="!isDeleting" #iconLeft
						><Icon name="lucide:trash-2" class="w-4 h-4"
					/></template>
					{{
						isDeleting
							? t('dashboard.audience.segments.index.deleting')
							: t('dashboard.audience.segments.index.deleteDialog.title')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Unsaved Changes Dialog (builder dismissed with pending edits) -->
		<UnsavedChangesDialog
			:show="showSegmentDiscardDialog"
			@close="showSegmentDiscardDialog = false"
			@discard="discardSegmentEdits"
			@save="saveSegmentEdits"
		/>
	</div>
</template>

<style scoped>
/* Button size variant */
.btn-sm {
	padding: 0.375rem 0.75rem;
	font-size: 0.75rem;
}
</style>
