<script setup lang="ts">
/**
 * Templates: one list of every email template with a type filter (#787).
 *
 * This used to be an overview of stat tiles, a "Quick Actions" row (which
 * also linked Media and Files) and two "recent" cards, each with its own
 * create button. Now there is one list, one filter and one "New template".
 * Saved blocks keep their own page, linked from the header; images are
 * picked from inside the email editor.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import { formatCompactRelativeTime } from '~/utils/formatters';
import {
	TEMPLATE_TYPE_FILTERS,
	parseTemplateTypeFilter,
	type TemplateTypeFilter,
} from '~/utils/templateListFilter';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.send.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
const { can, showGateFor } = usePermissions();
const canManage = computed(() => can('templates:manage'));
const showManageGate = computed(() => showGateFor('templates:manage'));
const { isPending: authPending, isAuthenticated } = useAuth();

// The filter lives in the URL (`?type=marketing`), so a filtered list can be
// linked to and survives a reload.
const typeFilter = computed<TemplateTypeFilter>({
	get: () => parseTemplateTypeFilter(route.query['type']),
	set: (value) => {
		void router.replace({ query: { ...route.query, type: value === 'all' ? undefined : value } });
	},
});

const { data: typeCounts } = useOrganizationQuery(
	api.emailTemplates.organization.countByTypeByOrganization
);
const { data: blocksStats } = useOrganizationQuery(api.emailBlocks.blocks.getStatsByTeam);

const {
	results: templates,
	status,
	isLoading,
	error,
	loadMore,
} = usePaginatedQuery(
	api.emailTemplates.emails.list,
	() => {
		if (authPending.value || !isAuthenticated.value) return 'skip';
		return typeFilter.value === 'all' ? {} : { type: typeFilter.value };
	},
	{ initialNumItems: 50 }
);

function countFor(filter: TemplateTypeFilter): number | null {
	const counts = typeCounts.value;
	if (!counts) return null;
	if (filter === 'all') return counts['total'] ?? 0;
	return counts[filter] ?? 0;
}

const filterOptions = computed(() =>
	TEMPLATE_TYPE_FILTERS.map((filter) => {
		const count = countFor(filter);
		const label = t(`dashboard.send.index.filters.${filter}`);
		return {
			value: filter,
			label: count === null ? label : `${label} (${count.toLocaleString(locale.value)})`,
		};
	})
);

const blockCount = computed(() => blocksStats.value?.total ?? null);

// Every template type opens in the same email editor.
function editPath(id: Id<'emailTemplates'>): string {
	return `/dashboard/send/emails/${id}/edit`;
}

function typeBadgeClass(type: string): string {
	return type === 'marketing' ? 'bg-brand-subtle text-brand' : 'bg-info-subtle text-info';
}

// --- New template (the same library modal the marketing list uses) ---------
const { run: createTemplate } = useBackendOperation(api.emailTemplates.emails.create, {
	label: () => t('dashboard.send.index.createOperation'),
});
const { run: createFromPreset } = useBackendOperation(
	api.emailTemplates.organization.createFromPreset,
	{ label: () => t('dashboard.send.index.createOperation') }
);

const isLibraryOpen = ref(false);
const libraryRef = ref<{
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
	isCreating: boolean;
} | null>(null);

async function handleCreateSubmit() {
	await libraryRef.value?.handleCreate(createTemplate, createFromPreset);
}

function handleCreated(templateId: Id<'emailTemplates'>) {
	void router.push(editPath(templateId));
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<UiPageHeader
			:title="t('dashboard.send.index.title')"
			:description="t('dashboard.send.index.subtitle')"
			class="mb-6"
		>
			<template #actions>
				<UiButton variant="secondary" to="/dashboard/send/blocks">
					<template #iconLeft><Icon name="lucide:layout-grid" class="w-4 h-4" /></template>
					{{
						blockCount === null
							? t('dashboard.send.index.savedBlocks')
							: t('dashboard.send.index.savedBlocksCount', {
									count: blockCount.toLocaleString(locale),
								})
					}}
				</UiButton>
				<UiButton v-if="canManage" data-testid="new-template" @click="isLibraryOpen = true">
					<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
					{{ t('dashboard.send.index.newTemplate') }}
				</UiButton>
				<p v-else-if="showManageGate" class="text-xs text-text-tertiary">
					{{ t('dashboard.send.index.adminsOnly') }}
				</p>
			</template>
		</UiPageHeader>

		<UiSegmentedControl
			v-model="typeFilter"
			:options="filterOptions"
			size="sm"
			class="mb-4"
			data-testid="template-type-filter"
		/>

		<UiCard padding="none" overflow="hidden">
			<UiQueryBoundary
				:loading="isLoading && templates.length === 0"
				:error="error"
				:error-title="t('dashboard.send.index.loadError')"
			>
				<template #loading>
					<DashboardListSkeleton variant="card" leading :rows="5" />
				</template>

				<UiEmptyState
					v-if="templates.length === 0"
					icon="lucide:file-text"
					:title="
						typeFilter === 'all'
							? t('dashboard.send.index.empty.title')
							: t(`dashboard.send.index.empty.filtered.${typeFilter}`)
					"
					:description="canManage ? t('dashboard.send.index.empty.description') : undefined"
				/>

				<ul v-else class="divide-y divide-border-subtle" data-testid="template-list">
					<li v-for="template in templates" :key="template._id">
						<NuxtLink
							:to="editPath(template._id)"
							class="flex items-center gap-4 px-4 py-3 hover:bg-bg-surface transition-colors"
						>
							<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="lg" />
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate font-medium">{{ template.name }}</p>
								<p v-if="template.subject" class="text-xs text-text-tertiary truncate">
									{{ template.subject }}
								</p>
							</div>
							<span
								:class="['text-xs px-1.5 py-0.5 rounded shrink-0', typeBadgeClass(template.type)]"
							>
								{{ t(`dashboard.send.index.templateTypes.${template.type}`) }}
							</span>
							<span
								class="hidden sm:inline text-xs text-text-tertiary shrink-0 w-24 text-right tabular-nums"
							>
								{{ formatCompactRelativeTime(template.updatedAt) }}
							</span>
						</NuxtLink>
					</li>
				</ul>
			</UiQueryBoundary>
		</UiCard>

		<div v-if="templates.length > 0 && status === 'CanLoadMore'" class="flex justify-center mt-6">
			<UiButton variant="outline" size="sm" @click="loadMore(50)">
				{{ t('dashboard.send.index.loadMore') }}
			</UiButton>
		</div>

		<LazyMailTemplateLibraryModal
			ref="libraryRef"
			v-model:open="isLibraryOpen"
			@create="handleCreated"
		>
			<template #submit-button="{ isCreating }">
				<UiButton type="submit" :loading="isCreating" @click="handleCreateSubmit">
					{{
						isCreating
							? t('dashboard.send.index.creating')
							: t('dashboard.send.index.createAndEdit')
					}}
				</UiButton>
			</template>
		</LazyMailTemplateLibraryModal>
	</div>
</template>
