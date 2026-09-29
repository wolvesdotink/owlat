<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { buildContactsCsv, downloadCsv, type CsvContact } from '~/utils/contactsCsv';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.segments.detail.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Breadcrumbs
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();

// Get the segment ID from the route
const segmentId = useRouteId<'segments'>();

// Organization loading state
const { isLoading: organizationLoading } = useOrganizationContext();

// Fetch segment details
const { data: segment, isLoading: segmentLoading } = useConvexQuery(api.segments.get, () => ({
	id: segmentId.value,
}));

// Fetch the contacts that currently match this segment (paginated). Segment
// membership is computed at read time, so each page scans a slice of the
// live-Contact population and returns just the matching subset.
const membersPage = usePaginatedQuery(api.segments.listMembers, () => ({ id: segmentId.value }), {
	initialNumItems: 200,
});
const membersLoading = membersPage.isLoading;

const isLoading = computed(
	() => organizationLoading.value || segmentLoading.value || membersLoading.value
);

// Contact-property labels for the editor context + describeFilters helper.
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);
const { results: topics } = useTopicsList();
const { describeFilters } = useSegmentFilters({ contactProperties, topics });

const filterSummary = computed(() => (segment.value ? describeFilters(segment.value.filters) : ''));

// Update breadcrumbs when segment data is loaded
watch(
	segment,
	(s) => {
		if (s) {
			setDynamicBreadcrumbs([
				{
					label: t('dashboard.audience.segments.detail.index.breadcrumbs.audience'),
					href: '/dashboard/audience',
				},
				{
					label: t('dashboard.audience.segments.detail.index.breadcrumbs.segments'),
					href: '/dashboard/audience/segments',
				},
				{ label: s.name },
			]);
		}
	},
	{ immediate: true }
);

onUnmounted(() => {
	clearDynamicBreadcrumbs();
});

// Search, sort and paging over the loaded members (client-side), pulling more
// server pages as the user nears the end or searches.
const members = reactive(
	useMemberTable({
		paginated: membersPage,
		dateField: 'createdAt',
		loadMoreSize: 200,
	})
);
const contactPath = (contact: { _id: Id<'contacts'> }) =>
	`/dashboard/audience/contacts/${contact._id}`;

// ─── Export ───────────────────────────────────────────────────────────────
// Export every contact the segment currently matches to CSV. The whole member
// set is resolved server-side in one call (segments.listMembersForExport walks
// all member pages on the backend) rather than draining the reactive
// `usePaginatedQuery` subscription client-side — a drain loop could exit early
// on a transient `LoadingMore` status and silently export a truncated window.
const isExporting = ref(false);
const { showToast } = useToast();
const convex = useConvex();

const handleExport = async () => {
	if (isExporting.value || !convex) return;
	isExporting.value = true;
	try {
		const { members: exportMembers, truncated } = await convex.action(
			api.segments.listMembersForExport,
			{ id: segmentId.value }
		);

		if (exportMembers.length === 0) {
			showToast(t('dashboard.audience.segments.detail.index.export.none'));
			return;
		}

		const csv = buildContactsCsv(exportMembers as CsvContact[], null, []);
		const safeName = (segment.value?.name ?? 'segment').replace(/[^\w.-]+/g, '_');
		downloadCsv(csv, `segment-${safeName}.csv`);
		showToast(
			truncated
				? t('dashboard.audience.segments.detail.index.export.truncated', {
						count: exportMembers.length,
					})
				: t(
						'dashboard.audience.segments.detail.index.export.done',
						{ count: exportMembers.length },
						exportMembers.length
					)
		);
	} catch {
		showToast(t('dashboard.audience.segments.detail.index.export.failed'), 'error');
	} finally {
		isExporting.value = false;
	}
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Loading State -->
		<DashboardDetailSkeleton
			v-if="isLoading && !segment"
			:label="t('dashboard.audience.segments.detail.index.loading')"
			back="button"
			lead="tile"
			meta
			body="table"
		/>

		<!-- Not Found State -->
		<div
			v-else-if="!isLoading && !segment"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:filter" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.audience.segments.detail.index.notFound.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.audience.segments.detail.index.notFound.body') }}
			</p>
			<UiButton to="/dashboard/audience/segments" class="mt-6">
				{{ t('dashboard.audience.segments.detail.index.notFound.action') }}
			</UiButton>
		</div>

		<!-- Main Content -->
		<template v-else-if="segment">
			<!-- Header -->
			<div class="flex items-start gap-4 mb-6">
				<NuxtLink
					to="/dashboard/audience/segments"
					class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors mt-1"
				>
					<Icon name="lucide:arrow-left" class="w-5 h-5" />
				</NuxtLink>
				<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
					<Icon name="lucide:filter" class="w-5 h-5 text-brand" />
				</div>
				<UiPageHeader class="flex-1" :title="segment.name" :description="segment.description">
					<template #meta>
						<div class="flex items-center flex-wrap gap-4 text-sm text-text-tertiary">
							<div class="flex items-center gap-1.5">
								<Icon name="lucide:users" class="w-4 h-4" />
								<span>{{
									t(
										'dashboard.audience.segments.detail.index.matchingContacts',
										{ count: segment.cachedCount ?? '—' },
										segment.cachedCount ?? 0
									)
								}}</span>
							</div>
							<div class="flex items-center gap-1.5">
								<Icon name="lucide:sliders-horizontal" class="w-4 h-4" />
								<span>{{ filterSummary }}</span>
							</div>
							<div class="flex items-center gap-1.5">
								<Icon name="lucide:calendar" class="w-4 h-4" />
								<span>{{
									t('dashboard.audience.segments.detail.index.createdOn', {
										date: formatDate(segment.createdAt),
									})
								}}</span>
							</div>
						</div>
					</template>
					<template #actions>
						<UiButton
							variant="secondary"
							:disabled="members.totalCount === 0"
							:loading="isExporting"
							@click="handleExport"
						>
							<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
							{{ t('dashboard.audience.segments.detail.index.exportCsv') }}
						</UiButton>
					</template>
				</UiPageHeader>
			</div>

			<AudienceMemberTable
				v-model:search="members.searchQuery"
				:rows="members.pageRows"
				date-field="createdAt"
				:row-to="contactPath"
				:active-search="members.debouncedSearch"
				:search-placeholder="t('dashboard.audience.segments.detail.index.searchPlaceholder')"
				:loading="membersLoading"
				:empty="{
					icon: 'lucide:users',
					title: t('dashboard.audience.segments.detail.index.empty.title'),
					description: t('dashboard.audience.segments.detail.index.empty.body'),
				}"
				:is-sortable="members.isSortable"
				:get-sort-icon="members.getSortIcon"
				:current-page="members.currentPage"
				:total-pages="members.totalPages"
				:page-numbers="members.pageNumbers"
				:showing-range="members.showingRange"
				@sort="members.toggleSort"
				@page="members.goToPage"
				@clear-search="members.clearSearch"
			>
				<template #empty-action>
					<UiButton variant="secondary" to="/dashboard/audience/segments">
						{{ t('dashboard.audience.segments.detail.index.empty.action') }}
					</UiButton>
				</template>
			</AudienceMemberTable>
		</template>
	</div>
</template>
