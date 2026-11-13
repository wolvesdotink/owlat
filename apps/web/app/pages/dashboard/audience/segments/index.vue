<script setup lang="ts">
import { api } from '@owlat/api';
import type { Condition } from '~/composables/conditions';
import AudienceSegmentConditions from '~/components/audience/AudienceSegmentConditions.vue';
import { FilterIcon, PlusIcon, UsersIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.audience.segments.index.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: 'auth' });

// ─── Organization & Data ───────────────────────────────────────────────
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();
// Creating, editing and deleting a segment all require `segments:manage`
// (owner/admin) on the backend — `apps/api/convex/segments/segments.ts`. The list itself
// is readable by every member, so only the write actions come off for an
// editor, with a line saying why rather than a silent absence.
const { can, showGateFor } = usePermissions();
const canManage = computed(() => can('segments:manage'));
const showManageGate = computed(() => showGateFor('segments:manage'));
// The list filters/sorts client-side with no pager, so an org with >100
// segments was silently capped at the first 100. Pull every page.
const {
	results: segments,
	isLoading: segmentsLoading,
	error: segmentsError,
	refetch: refetchSegments,
} = useLoadAllPages(
	useOrganizationPaginatedQuery(api.segments.segments.list, undefined, { initialNumItems: 100 }),
	100
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
const {
	searchQuery,
	debouncedSearch,
	clearSearch,
	sortBy,
	sortOrder,
	toggleSort,
	getSortIcon,
	getAriaSort,
} = useDataTable<SortField>({
	defaultSort: 'createdAt',
	defaultOrder: 'desc',
	sortableFields: ['name', 'cachedCount', 'createdAt'],
});

const filteredSegments = computed(() => {
	const query = debouncedSearch.value.toLowerCase();
	const list = query
		? segments.value.filter(
				(segment) =>
					segment.name.toLowerCase().includes(query) ||
					(segment.description && segment.description.toLowerCase().includes(query))
			)
		: [...segments.value];

	return list.sort((a, b) => {
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
});

type SegmentRow = (typeof segments.value)[number];
const segmentPath = (segment: { _id: string }) => `/dashboard/audience/segments/${segment._id}`;
const filterSummaryOf = (segment: SegmentRow) => describeFilters(segment.filters);

// Props shared by the table and the mobile card list; `ListPageShell` mounts
// one. The card's second line falls back to the filter summary, because the
// card has no filter column.
const listTable = computed(() => ({
	items: filteredSegments.value,
	icon: FilterIcon,
	itemTo: segmentPath,
	countOf: (segment: { cachedCount?: number | null }) => segment.cachedCount,
	countField: 'cachedCount' as const,
	countHeader: t('dashboard.audience.segments.index.table.contacts'),
	createdHeader: t('dashboard.audience.segments.index.table.created'),
	totalText: t(
		'dashboard.audience.segments.index.count',
		{ count: filteredSegments.value.length },
		filteredSegments.value.length
	),
	editLabel: t('dashboard.audience.segments.index.actions.edit'),
	deleteLabel: t('dashboard.audience.segments.index.actions.delete'),
	canManage: canManage.value,
	getSortIcon,
	getAriaSort,
	subtitleOf: (segment: SegmentRow) => segment.description || filterSummaryOf(segment),
	onSort: toggleSort,
	onEdit: openEditModal,
	onDelete: openDeleteModal,
}));

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
	// Same guard the contacts list puts on its own `?action=add` link: the hub
	// card is a create button like any other, so a caller who cannot create must
	// not land on a modal whose submit would 403.
	if (canManage.value && route.query['action'] === 'create') {
		openCreateModal();
	}
});
</script>

<template>
	<ListPageShell
		v-model:search="searchQuery"
		:title="t('dashboard.audience.segments.index.title')"
		:description="t('dashboard.audience.segments.index.subtitle')"
		:loading="isLoading && segments.length === 0"
		:error="segmentsError"
		:error-title="t('dashboard.audience.segments.index.errorTitle')"
		:has-organization="hasActiveOrganization"
		:is-empty="filteredSegments.length === 0"
		:active-search="debouncedSearch"
		:search-placeholder="t('dashboard.audience.segments.index.searchPlaceholder')"
		:empty-no-org="{
			icon: FilterIcon,
			title: t('dashboard.audience.segments.index.noWorkspace.title'),
			description: t('dashboard.audience.segments.index.noWorkspace.description'),
		}"
		:empty="{
			icon: FilterIcon,
			title: t('dashboard.audience.segments.index.empty.title'),
			description: t('dashboard.audience.segments.index.empty.description'),
		}"
		:no-results="{
			title: t('dashboard.audience.segments.index.noResults.title'),
			description: t('dashboard.audience.segments.index.noResults.description', {
				query: debouncedSearch,
			}),
		}"
		:delete-copy="{
			title: t('dashboard.audience.segments.index.deleteDialog.title'),
			confirmKeypath: 'dashboard.audience.segments.index.deleteDialog.body',
			description: t('dashboard.audience.segments.index.deleteDialog.note'),
			confirmText: t('dashboard.audience.segments.index.deleteDialog.title'),
		}"
		:delete-open="isDeleteModalOpen"
		:delete-name="deleteTarget?.name"
		:is-deleting="isDeleting"
		@retry="refetchSegments"
		@clear-search="clearSearch"
		@confirm-delete="handleDelete"
		@cancel-delete="closeDeleteModal"
	>
		<template #before-header>
			<AudienceTabs />
		</template>

		<template #actions>
			<UiButton v-if="canManage" @click="openCreateModal">
				<template #iconLeft><PlusIcon class="w-4 h-4" /></template>
				{{ t('dashboard.audience.segments.index.newSegment') }}
			</UiButton>
			<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
				{{ t('dashboard.audience.segments.index.adminsOnly') }}
			</p>
		</template>

		<template #loading>
			<DashboardListSkeleton variant="table" :columns="5" :rows="6" />
		</template>

		<template v-if="canManage" #empty-action>
			<UiButton @click="openCreateModal">
				<template #iconLeft><PlusIcon class="w-4 h-4" /></template>
				{{ t('dashboard.audience.segments.index.newSegment') }}
			</UiButton>
		</template>

		<template #table>
			<AudienceListTable v-bind="listTable" layout="table">
				<template #extra-header>
					{{ t('dashboard.audience.segments.index.table.filters') }}
				</template>
				<template #extra-cell="{ item }">
					<!-- One line however many conditions; the full summary is in the title. -->
					<span
						class="block max-w-xs truncate text-text-secondary text-sm"
						:title="filterSummaryOf(item as SegmentRow)"
						>{{ filterSummaryOf(item as SegmentRow) }}</span
					>
				</template>
				<template #actions="{ item }">
					<UiTooltip :text="t('dashboard.audience.segments.index.actions.viewContacts')">
						<NuxtLink
							:to="segmentPath(item)"
							class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							:aria-label="t('dashboard.audience.segments.index.actions.viewContacts')"
						>
							<UsersIcon class="w-4 h-4" />
						</NuxtLink>
					</UiTooltip>
				</template>
			</AudienceListTable>
		</template>

		<template #cards>
			<AudienceListTable v-bind="listTable" layout="cards" />
		</template>

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
					role="alert"
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
						:aria-invalid="segmentErrors.name ? 'true' : undefined"
						:aria-describedby="segmentErrors.name ? 'segment-name-error' : undefined"
						:disabled="isSaving"
					/>
					<p v-if="segmentErrors.name" id="segment-name-error" class="error-message">
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
					<p id="segment-logic-label" class="label">
						{{ t('dashboard.audience.segments.index.modal.matchLabel') }}
					</p>
					<div role="group" aria-labelledby="segment-logic-label" class="flex gap-2">
						<button
							type="button"
							:aria-pressed="segmentForm.filters.logic === 'AND'"
							:class="[
								'px-4 py-2 pointer-coarse:min-h-11 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
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
							:aria-pressed="segmentForm.filters.logic === 'OR'"
							:class="[
								'px-4 py-2 pointer-coarse:min-h-11 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
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
				<AudienceSegmentConditions
					:conditions="segmentForm.filters.conditions"
					:error="segmentErrors.conditions"
					@add="addCondition"
					@remove="removeCondition"
					@update="updateConditionAt"
				/>

				<!-- Matching contacts count -->
				<div class="mb-6 p-4 bg-bg-surface rounded-xl border border-border-subtle">
					<div class="flex items-center gap-3">
						<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
							<UsersIcon class="w-5 h-5 text-brand" />
						</div>
						<div>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.audience.segments.index.modal.matchingContacts') }}
							</p>
							<p class="text-xl font-semibold text-text-primary">
								<template v-if="countLoading">
									<SpinnerIcon class="w-5 h-5 inline" />
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
				<UiButton variant="secondary" :disabled="isSaving" @click="requestCloseSegmentModal">
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

		<!-- Unsaved Changes Dialog (builder dismissed with pending edits) -->
		<UiUnsavedChangesDialog
			:show="showSegmentDiscardDialog"
			@close="showSegmentDiscardDialog = false"
			@discard="discardSegmentEdits"
			@save="saveSegmentEdits"
		/>
	</ListPageShell>
</template>
