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

const router = useRouter();

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
const {
	results: members,
	isLoading: membersLoading,
	loadMore,
	status: membersPaginationStatus,
} = usePaginatedQuery(api.segments.listMembers, () => ({ id: segmentId.value }), {
	initialNumItems: 200,
});

const isLoading = computed(
	() => organizationLoading.value || segmentLoading.value || membersLoading.value
);

// Below md the four columns have nowhere to go — the same rows render as a card
// list instead (one tap opens the contact).
const tableFits = useDataTableViewport();

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

// Search state (debounced)
const searchQuery = ref('');
const debouncedSearch = ref('');
let searchTimeout: ReturnType<typeof setTimeout> | null = null;

watch(searchQuery, (value) => {
	if (searchTimeout) clearTimeout(searchTimeout);
	searchTimeout = setTimeout(() => {
		debouncedSearch.value = value;
	}, 300);
});

// Pagination state (client-side over the loaded member window)
const currentPage = ref(1);
const pageSize = 25;

// Sorting state
type SortField = 'email' | 'firstName' | 'lastName' | 'createdAt';
const sortBy = ref<SortField>('email');
const sortOrder = ref<'asc' | 'desc'>('asc');

watch([debouncedSearch, sortBy, sortOrder], () => {
	currentPage.value = 1;
});

// Filtered and sorted members
const filteredMembers = computed(() => {
	if (!members.value) return [];

	let list = [...members.value];

	if (debouncedSearch.value) {
		const query = debouncedSearch.value.toLowerCase();
		list = list.filter(
			(contact) =>
				(contact.email && contact.email.toLowerCase().includes(query)) ||
				(contact.firstName && contact.firstName.toLowerCase().includes(query)) ||
				(contact.lastName && contact.lastName.toLowerCase().includes(query))
		);
	}

	list.sort((a, b) => {
		let comparison = 0;
		if (sortBy.value === 'email') {
			comparison = (a.email ?? '').localeCompare(b.email ?? '');
		} else if (sortBy.value === 'firstName') {
			comparison = (a.firstName || '').localeCompare(b.firstName || '');
		} else if (sortBy.value === 'lastName') {
			comparison = (a.lastName || '').localeCompare(b.lastName || '');
		} else if (sortBy.value === 'createdAt') {
			comparison = (a.createdAt ?? 0) - (b.createdAt ?? 0);
		}
		return sortOrder.value === 'asc' ? comparison : -comparison;
	});

	return list;
});

const paginatedMembers = computed(() => {
	const start = (currentPage.value - 1) * pageSize;
	return filteredMembers.value.slice(start, start + pageSize);
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredMembers.value.length / pageSize)));
const totalCount = computed(() => filteredMembers.value.length);

const canGoPrev = computed(() => currentPage.value > 1);
const canGoNext = computed(() => currentPage.value < totalPages.value);

// The server query is cursor-paginated but the table pages client-side over the
// loaded set. Progressively pull more pages: when the user nears the end of the
// loaded window, and eagerly while a search is active (client-side search must
// see every member to find a match). Mirrors topics/[id]/index.vue.
const canLoadMore = computed(() => membersPaginationStatus.value === 'CanLoadMore');
watch(
	[currentPage, debouncedSearch, membersPaginationStatus],
	() => {
		if (!canLoadMore.value) return;
		const loaded = members.value?.length ?? 0;
		const needed = currentPage.value * pageSize + pageSize;
		if (debouncedSearch.value || loaded < needed) {
			loadMore(200);
		}
	},
	{ immediate: true }
);

const goToPage = (page: number) => {
	if (page >= 1 && page <= totalPages.value) {
		currentPage.value = page;
	}
};

const handleSort = (field: SortField) => {
	if (sortBy.value === field) {
		sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
	} else {
		sortBy.value = field;
		sortOrder.value = 'asc';
	}
};

const getSortIcon = (field: SortField): string | null => {
	if (sortBy.value !== field) return null;
	return sortOrder.value === 'asc' ? 'lucide:chevron-up' : 'lucide:chevron-down';
};

const pageNumbers = computed(() => {
	const pages: (number | '...')[] = [];
	const total = totalPages.value;
	const current = currentPage.value;

	if (total <= 7) {
		for (let i = 1; i <= total; i++) pages.push(i);
	} else if (current <= 3) {
		pages.push(1, 2, 3, 4, '...', total);
	} else if (current >= total - 2) {
		pages.push(1, '...', total - 3, total - 2, total - 1, total);
	} else {
		pages.push(1, '...', current - 1, current, current + 1, '...', total);
	}

	return pages;
});

const showingRange = computed(() => {
	if (totalCount.value === 0) return t('dashboard.audience.segments.detail.index.showing.empty');
	const start = (currentPage.value - 1) * pageSize + 1;
	const end = Math.min(currentPage.value * pageSize, totalCount.value);
	return t('dashboard.audience.segments.detail.index.showing.range', {
		start,
		end,
		total: totalCount.value,
	});
});

// Navigate to a contact's detail page.
const viewContact = (contactId: Id<'contacts'>) => {
	router.push(`/dashboard/audience/contacts/${contactId}`);
};

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
		<div v-if="isLoading && !segment" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.audience.segments.detail.index.loading') }}
				</p>
			</div>
		</div>

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
							:disabled="totalCount === 0"
							:loading="isExporting"
							@click="handleExport"
						>
							<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
							{{ t('dashboard.audience.segments.detail.index.exportCsv') }}
						</UiButton>
					</template>
				</UiPageHeader>
			</div>

			<!-- Search Bar -->
			<div class="mb-6">
				<div class="relative max-w-md">
					<Icon
						name="lucide:search"
						class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
					/>
					<input
						v-model="searchQuery"
						type="text"
						:placeholder="t('dashboard.audience.segments.detail.index.searchPlaceholder')"
						class="input pl-10"
					/>
				</div>
			</div>

			<!-- Contacts Table -->
			<div class="card p-0 overflow-hidden">
				<!-- Empty State (no matching contacts) -->
				<div
					v-if="!membersLoading && filteredMembers.length === 0 && !debouncedSearch"
					class="flex flex-col items-center justify-center py-16 text-center px-6"
				>
					<UiIconBox icon="lucide:users" size="xl" variant="surface" rounded="full" class="mb-4" />
					<p class="text-text-secondary font-medium">
						{{ t('dashboard.audience.segments.detail.index.empty.title') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						{{ t('dashboard.audience.segments.detail.index.empty.body') }}
					</p>
					<UiButton variant="secondary" to="/dashboard/audience/segments" class="gap-2 mt-6">
						{{ t('dashboard.audience.segments.detail.index.empty.action') }}
					</UiButton>
				</div>

				<!-- Empty State (no search results) -->
				<div
					v-else-if="!membersLoading && filteredMembers.length === 0 && debouncedSearch"
					class="flex flex-col items-center justify-center py-16 text-center px-6"
				>
					<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
					<p class="text-text-secondary font-medium">
						{{ t('dashboard.audience.segments.detail.index.noResults.title') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						{{
							t('dashboard.audience.segments.detail.index.noResults.body', {
								query: debouncedSearch,
							})
						}}
					</p>
					<UiButton
						variant="secondary"
						class="mt-6"
						@click="
							searchQuery = '';
							debouncedSearch = '';
						"
					>
						{{ t('dashboard.audience.segments.detail.index.clearSearch') }}
					</UiButton>
				</div>

				<!-- Data Table -->
				<div v-else>
					<!-- Card list below md. The two are alternatives, not layers: a
					     CSS-only switch would keep both copies of every row in the DOM. -->
					<ul v-if="!tableFits" class="divide-y divide-border-subtle">
						<li v-for="contact in paginatedMembers" :key="contact._id">
							<button
								type="button"
								class="w-full text-left px-4 py-3 transition-colors hover:bg-bg-surface"
								@click="viewContact(contact._id)"
							>
								<span class="block text-text-primary font-medium truncate">{{ contact.email }}</span>
								<span
									v-if="contact.firstName || contact.lastName"
									class="block text-sm text-text-secondary truncate"
								>
									{{ [contact.firstName, contact.lastName].filter(Boolean).join(' ') }}
								</span>
								<span class="block text-xs text-text-tertiary mt-0.5">
									{{ formatDate(contact.createdAt) }}
								</span>
							</button>
						</li>
					</ul>

					<div v-else class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('email')"
									>
										<div class="flex items-center gap-1">
											{{ t('common.email') }}
											<Icon
												v-if="getSortIcon('email')"
												:name="getSortIcon('email')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('firstName')"
									>
										<div class="flex items-center gap-1">
											{{ t('dashboard.audience.segments.detail.index.table.firstName') }}
											<Icon
												v-if="getSortIcon('firstName')"
												:name="getSortIcon('firstName')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('lastName')"
									>
										<div class="flex items-center gap-1">
											{{ t('dashboard.audience.segments.detail.index.table.lastName') }}
											<Icon
												v-if="getSortIcon('lastName')"
												:name="getSortIcon('lastName')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('createdAt')"
									>
										<div class="flex items-center gap-1">
											{{ t('dashboard.audience.segments.detail.index.table.added') }}
											<Icon
												v-if="getSortIcon('createdAt')"
												:name="getSortIcon('createdAt')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="contact in paginatedMembers"
									:key="contact._id"
									class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer"
									@click="viewContact(contact._id)"
								>
									<td class="px-6 py-4">
										<span class="text-text-primary font-medium">{{ contact.email }}</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-secondary">{{ contact.firstName || '—' }}</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-secondary">{{ contact.lastName || '—' }}</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-tertiary text-sm">{{
											formatDate(contact.createdAt)
										}}</span>
									</td>
								</tr>
							</tbody>
						</table>
					</div>

					<!-- Pagination -->
					<div
						v-if="totalPages > 1 || totalCount > 0"
						class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 border-t border-border-subtle"
					>
						<p class="text-sm text-text-tertiary">
							{{
								t('dashboard.audience.segments.detail.index.showing.label', { range: showingRange })
							}}
						</p>

						<div class="flex items-center gap-1">
							<button
								class="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:pointer-events-none transition-colors"
								:disabled="!canGoPrev"
								:aria-label="t('dashboard.audience.segments.detail.index.pagination.previous')"
								@click="goToPage(currentPage - 1)"
							>
								<Icon name="lucide:chevron-left" class="w-4 h-4" />
							</button>

							<template v-for="(page, index) in pageNumbers" :key="index">
								<span v-if="page === '...'" class="px-2 text-text-tertiary"> ... </span>
								<button
									v-else
									:class="[
										'min-w-[32px] h-8 px-2 rounded-lg text-sm font-medium transition-colors',
										page === currentPage
											? 'bg-text-primary text-text-inverse'
											: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
									]"
									@click="goToPage(page)"
								>
									{{ page }}
								</button>
							</template>

							<button
								class="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:pointer-events-none transition-colors"
								:disabled="!canGoNext"
								:aria-label="t('dashboard.audience.segments.detail.index.pagination.next')"
								@click="goToPage(currentPage + 1)"
							>
								<Icon name="lucide:chevron-right" class="w-4 h-4" />
							</button>
						</div>
					</div>
				</div>
			</div>
		</template>
	</div>
</template>
