<script setup lang="ts">
import { api } from '@owlat/api';
import type { Condition } from '~/composables/conditions';

useHead({ title: 'Segments — Owlat' });
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
				<h1 class="text-2xl font-semibold text-text-primary">Segments</h1>
				<p class="mt-1 text-text-secondary">
					Create and manage audience segments for targeted campaigns
				</p>
			</div>
			<UiButton @click="openCreateModal">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				New Segment
			</UiButton>
		</div>

		<!-- Search Bar -->
		<div class="mb-6 max-w-md">
			<UiInput v-model="searchQuery" placeholder="Search segments...">
				<template #iconLeft><Icon name="lucide:search" /></template>
			</UiInput>
		</div>

		<!-- Content -->
		<UiCard padding="none" overflow="hidden">
			<UiQueryBoundary
				:loading="isLoading && segments.length === 0"
				:error="segmentsError"
				error-title="Couldn't load segments"
				loading-label="Loading segments..."
			>
				<!-- Loading State: content-shaped skeleton on first load only -->
				<template #loading>
					<DashboardListSkeleton variant="table" :columns="6" :rows="6" />
				</template>

				<!-- Empty State (no organization) -->
				<UiEmptyState
					v-if="!hasActiveOrganization"
					icon="lucide:filter"
					title="No workspace selected"
					description="Create or select a workspace to start managing your segments."
				/>

				<!-- Empty State (no segments) -->
				<UiEmptyState
					v-else-if="!isLoading && filteredSegments.length === 0 && !searchQuery"
					icon="lucide:filter"
					title="No segments yet"
					description="Create your first segment to filter contacts based on properties, activity, and more."
				>
					<template #action>
						<UiButton @click="openCreateModal">
							<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
							New Segment
						</UiButton>
					</template>
				</UiEmptyState>

				<!-- Empty State (no search results) -->
				<UiEmptyState
					v-else-if="!isLoading && filteredSegments.length === 0 && searchQuery"
					icon="lucide:search"
					title="No results found"
					:description="`No segments match &quot;${searchQuery}&quot;. Try a different search term.`"
				>
					<template #action>
						<UiButton variant="secondary" @click="searchQuery = ''">Clear search</UiButton>
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
											Name
											<Icon
												v-if="getSortIcon('name')"
												:name="getSortIcon('name')!"
												class="w-4 h-4"
											/>
										</button>
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										Filters
									</th>
									<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
										<button
											type="button"
											class="flex items-center gap-1 py-4 -my-4 px-1 -mx-1 rounded hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
											@click="toggleSort('cachedCount')"
										>
											Contacts
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
											Created
											<Icon
												v-if="getSortIcon('createdAt')"
												:name="getSortIcon('createdAt')!"
												class="w-4 h-4"
											/>
										</button>
									</th>
									<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
										Actions
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
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
												title="View contacts"
											>
												<Icon name="lucide:users" class="w-4 h-4" />
											</NuxtLink>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
												title="Edit segment"
												@click="openEditModal(segment)"
											>
												<Icon name="lucide:pencil" class="w-4 h-4" />
											</button>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
												title="Delete segment"
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
							{{ filteredSegments.length }} segment{{ filteredSegments.length !== 1 ? 's' : '' }}
						</p>
					</div>
				</div>
			</UiQueryBoundary>
		</UiCard>

		<!-- Create/Edit Segment Modal -->
		<UiModal
			:open="isSegmentModalOpen"
			:title="isEditMode ? 'Edit Segment' : 'Create Segment'"
			size="2xl"
			:closable="!isSaving"
			:persistent="isSaving"
			@update:open="
				(v) => {
					if (!v) closeSegmentModal();
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
					<label for="segment-name" class="label"> Name <span class="text-error">*</span> </label>
					<input
						id="segment-name"
						v-model="segmentForm.name"
						type="text"
						placeholder="e.g., Active Subscribers"
						:class="['input', segmentErrors.name ? 'input-error' : '']"
						:disabled="isSaving"
					/>
					<p v-if="segmentErrors.name" class="error-message">
						{{ segmentErrors.name }}
					</p>
				</div>

				<!-- Description Field -->
				<div class="mb-6">
					<label for="segment-description" class="label">Description</label>
					<textarea
						id="segment-description"
						v-model="segmentForm.description"
						rows="2"
						placeholder="Optional description for this segment..."
						class="input resize-none"
						:disabled="isSaving"
					/>
				</div>

				<!-- Filter Logic -->
				<div class="mb-4">
					<label class="label">Match contacts that meet</label>
					<div class="flex gap-2">
						<button
							type="button"
							:class="[
								'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
								segmentForm.filters.logic === 'AND'
									? 'bg-brand text-text-inverse'
									: 'bg-bg-surface text-text-secondary hover:text-text-primary',
							]"
							@click="segmentForm.filters.logic = 'AND'"
						>
							All conditions (AND)
						</button>
						<button
							type="button"
							:class="[
								'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
								segmentForm.filters.logic === 'OR'
									? 'bg-brand text-text-inverse'
									: 'bg-bg-surface text-text-secondary hover:text-text-primary',
							]"
							@click="segmentForm.filters.logic = 'OR'"
						>
							Any condition (OR)
						</button>
					</div>
				</div>

				<!-- Conditions -->
				<div class="mb-6">
					<div class="flex items-center justify-between mb-3">
						<label class="label mb-0">Conditions</label>
						<button type="button" class="btn btn-secondary btn-sm gap-1" @click="addCondition">
							<Icon name="lucide:plus" class="w-3 h-3" />
							Add Condition
						</button>
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
						<p class="text-text-secondary text-sm">No conditions added yet</p>
						<p class="text-text-tertiary text-xs mt-1">
							Click "Add Condition" to start filtering contacts
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
									class="shrink-0 p-1.5 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
									title="Remove condition"
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
							<p class="text-sm text-text-secondary">Matching contacts</p>
							<p class="text-xl font-semibold text-text-primary">
								<template v-if="countLoading">
									<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin inline" />
								</template>
								<template v-else>
									{{ matchingCount?.toLocaleString() ?? 0 }}
								</template>
							</p>
						</div>
					</div>
				</div>
			</form>

			<!-- Footer Actions -->
			<template #footer>
				<UiButton variant="secondary" :disabled="isSaving" @click="closeSegmentModal">
					Cancel
				</UiButton>
				<UiButton type="submit" form="segment-form" :loading="isSaving">
					{{ isSaving ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Segment' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiModal v-model:open="isDeleteModalOpen" title="Delete Segment">
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error-subtle flex items-center justify-center">
					<Icon name="lucide:alert-triangle" class="w-6 h-6 text-error" />
				</div>
				<div>
					<p class="text-text-primary font-medium">
						Are you sure you want to delete "{{ deleteTarget?.name }}"?
					</p>
					<p class="text-sm text-text-secondary mt-1">
						This action cannot be undone. Any campaigns using this segment will need to be updated.
					</p>
				</div>
			</div>
			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					Cancel
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					<template v-if="!isDeleting" #iconLeft
						><Icon name="lucide:trash-2" class="w-4 h-4"
					/></template>
					{{ isDeleting ? 'Deleting...' : 'Delete Segment' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>

<style scoped>
/* Button size variant */
.btn-sm {
	padding: 0.375rem 0.75rem;
	font-size: 0.75rem;
}
</style>
