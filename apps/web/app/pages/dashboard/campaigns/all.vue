<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'All Campaigns — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Keyboard shortcuts
const { registerNewShortcut, registerEscapeHandler, unregisterShortcut } = useKeyboardShortcuts();

onMounted(() => {
	// 'n' to create new campaign
	registerNewShortcut(() => {
		if (!isDeleteModalOpen.value) {
			router.push('/dashboard/campaigns/new');
		}
	});

	// Escape to close delete modal
	registerEscapeHandler(() => {
		if (isDeleteModalOpen.value && !isDeleting.value) {
			closeDeleteModal();
		}
	});
});

onUnmounted(() => {
	unregisterShortcut('n');
	unregisterShortcut('escape');
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();
const router = useRouter();
const route = useRoute();

// Status filter state - check for query param
const initialStatus = (route.query['status'] as CampaignStatusFilter) || 'all';
const selectedStatus = ref<CampaignStatusFilter>(initialStatus);

// Search state
const searchQuery = ref('');
const debouncedSearch = ref('');
let searchTimeout: ReturnType<typeof setTimeout> | null = null;

// Debounce search input
watch(searchQuery, (value) => {
	if (searchTimeout) {
		clearTimeout(searchTimeout);
	}
	searchTimeout = setTimeout(() => {
		debouncedSearch.value = value;
	}, 300);
});

function clearSearch() {
	searchQuery.value = '';
	debouncedSearch.value = '';
}

// Status filter options
const statusFilters: { value: CampaignStatusFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'draft', label: 'Draft' },
	{ value: 'scheduled', label: 'Scheduled' },
	{ value: 'sent', label: 'Sent' },
	{ value: 'pending_review', label: 'Under Review' },
];

// Fetch campaigns with cursor-based pagination (uses session-based organization context)
const {
	results: campaigns,
	status: paginationStatus,
	loadMore,
	isLoading: campaignsLoading,
} = usePaginatedQuery(
	api.campaigns.campaigns.list,
	() => ({
		status: selectedStatus.value === 'all' ? undefined : selectedStatus.value,
		search: debouncedSearch.value || undefined,
	}),
	{ initialNumItems: 50 }
);

const canLoadMore = computed(() => paginationStatus.value === 'CanLoadMore');
const isLoadingMore = computed(() => paginationStatus.value === 'LoadingMore');

const handleLoadMore = () => {
	if (canLoadMore.value) {
		loadMore(50);
	}
};

// Fetch campaign counts by status
const { data: statusCounts } = useOrganizationQuery(api.campaigns.organization.countByStatusByOrganization);

const isLoading = computed(() => teamLoading.value || campaignsLoading.value);

// Mutations
const { run: duplicateCampaign } = useBackendOperation(api.campaigns.campaigns.duplicate, {
	label: 'Duplicate campaign',
});
const { run: deleteCampaign } = useBackendOperation(api.campaigns.campaigns.remove, {
	label: 'Delete campaign',
});

// Get status badge configuration
const { getStatusBadge } = useCampaignStatusBadge();

// Get audience display text
const getAudienceText = (campaign: {
	audience?: { kind: 'topic' | 'segment' };
}) => {
	switch (campaign.audience?.kind) {
		case 'topic':
			return 'Topic';
		case 'segment':
			return 'Segment';
		default:
			return 'Not set';
	}
};

// Calculate open rate
const getOpenRate = (campaign: { statsOpened?: number; statsDelivered?: number }) => {
	if (!campaign.statsDelivered || campaign.statsDelivered === 0) return '—';
	const rate = ((campaign.statsOpened || 0) / campaign.statsDelivered) * 100;
	return `${rate.toFixed(1)}%`;
};

// Action dropdown state (using reactive object for AppDropdownMenu v-model:open per item)
const dropdownOpenStates = reactive<Record<string, boolean>>({});

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Handle duplicate
const handleDuplicate = async (campaignId: Id<'campaigns'>) => {
	const newCampaignId = await duplicateCampaign({ campaignId });
	if (newCampaignId === undefined) return;
	showNotification('Campaign duplicated successfully');
	// Redirect to the new campaign editor
	router.push(`/dashboard/campaigns/${newCampaignId}/edit`);
};

// Delete confirmation modal
const isDeleteModalOpen = ref(false);
const campaignToDelete = ref<{ id: Id<'campaigns'>; name: string } | null>(null);
const isDeleting = ref(false);

const openDeleteModal = (id: Id<'campaigns'>, name: string) => {
	campaignToDelete.value = { id, name };
	isDeleteModalOpen.value = true;
};

const closeDeleteModal = () => {
	isDeleteModalOpen.value = false;
	campaignToDelete.value = null;
};

const handleDelete = async () => {
	if (!campaignToDelete.value) return;

	isDeleting.value = true;
	try {
		const result = await deleteCampaign({ campaignId: campaignToDelete.value.id });
		if (result === undefined) return;
		showNotification('Campaign deleted successfully');
		closeDeleteModal();
	} finally {
		isDeleting.value = false;
	}
};

// Navigate to campaign builder
const handleNewCampaign = () => {
	router.push('/dashboard/campaigns/new');
};

// Navigate to edit campaign
const handleEdit = (campaignId: Id<'campaigns'>) => {
	router.push(`/dashboard/campaigns/${campaignId}/edit`);
};

// Navigate to campaign report
const handleViewReport = (campaignId: Id<'campaigns'>) => {
	router.push(`/dashboard/campaigns/${campaignId}/report`);
};

// Handle campaign name click - view report if sent, otherwise edit
const handleCampaignClick = (campaign: { _id: Id<'campaigns'>; status: string }) => {
	if (campaign.status === 'sent') {
		handleViewReport(campaign._id);
	} else {
		handleEdit(campaign._id);
	}
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div class="flex items-center gap-4">
				<NuxtLink
					to="/dashboard/campaigns"
					class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
					title="Back to Dashboard"
				>
					<Icon name="lucide:arrow-left" class="w-5 h-5" />
				</NuxtLink>
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">All Campaigns</h1>
					<p class="mt-1 text-text-secondary">View and manage all your email campaigns</p>
				</div>
			</div>
			<UiButton @click="handleNewCampaign">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				New Campaign
			</UiButton>
		</div>

		<!-- Filters and Search -->
		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<!-- Status Filters -->
			<div class="flex items-center gap-1 p-1 bg-bg-surface rounded-lg">
				<button
					v-for="filter in statusFilters"
					:key="filter.value"
					:class="[
						'px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
						selectedStatus === filter.value
							? 'bg-bg-elevated text-text-primary shadow-sm'
							: 'text-text-secondary hover:text-text-primary',
					]"
					@click="selectedStatus = filter.value"
				>
					{{ filter.label }}
					<span v-if="statusCounts" class="text-xs text-text-tertiary">
						({{ filter.value === 'all' ? statusCounts['total'] : statusCounts[filter.value] }})
					</span>
				</button>
			</div>

			<div class="flex-1" />

			<!-- Search -->
			<div class="relative">
				<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
				<input
					v-model="searchQuery"
					type="text"
					placeholder="Search campaigns..."
					class="input pl-10 w-64"
				/>
			</div>
		</div>

		<!-- Content -->
		<div>
			<!-- Loading State -->
			<div v-if="isLoading && !campaigns" class="flex items-center justify-center py-16">
				<div class="flex flex-col items-center gap-3">
					<div
						class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin"
					/>
					<p class="text-text-secondary text-sm">Loading campaigns...</p>
				</div>
			</div>

			<!-- Empty State (no organization) -->
			<UiCard
				v-else-if="!hasActiveOrganization"
				class="flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:send" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No organization selected</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Create or select an organization to start creating campaigns.
				</p>
			</UiCard>

			<!-- Empty State (no campaigns) -->
			<UiCard
				v-else-if="!isLoading && (!campaigns || campaigns.length === 0) && !debouncedSearch"
				class="flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:send" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No campaigns yet</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Create your first campaign to start sending emails to your audience.
				</p>
				<UiButton class="mt-6" @click="handleNewCampaign">
					<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
					Create Campaign
				</UiButton>
			</UiCard>

			<!-- Empty State (no search results) -->
			<UiCard
				v-else-if="!isLoading && (!campaigns || campaigns.length === 0) && debouncedSearch"
				class="flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No results found</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					No campaigns match "{{ debouncedSearch }}". Try a different search term.
				</p>
				<UiButton variant="secondary" class="mt-6" @click="clearSearch">Clear search</UiButton>
			</UiCard>

			<!-- Campaigns Table -->
			<UiCard v-else padding="none" overflow="hidden">
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-border-subtle">
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Name</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Status</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									Audience
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									Sent Date
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									Open Rate
								</th>
								<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
									Actions
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="campaign in campaigns"
								:key="campaign._id"
								class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors"
							>
								<td class="px-6 py-4">
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<span
												class="text-text-primary font-medium hover:text-brand cursor-pointer transition-colors"
												@click="handleCampaignClick(campaign)"
											>
												{{ campaign.name }}
											</span>
											<span
												v-if="campaign.isABTest"
												class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-brand/10 text-brand rounded text-xs font-medium"
												title="A/B Test"
											>
												<Icon name="lucide:split" class="w-3 h-3" />
												A/B
											</span>
										</div>
										<p v-if="campaign.subject" class="text-sm text-text-tertiary truncate mt-0.5">
											{{ campaign.subject }}
										</p>
									</div>
								</td>
								<td class="px-6 py-4">
									<span
										:class="[
											'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
											getStatusBadge(campaign.status).color,
										]"
									>
										<Icon
											:name="getStatusBadge(campaign.status).icon"
											:class="['w-3 h-3', campaign.status === 'sending' ? 'animate-spin' : '']"
										/>
										{{ getStatusBadge(campaign.status).label }}
									</span>
									<p
										v-if="campaign.contentBlockReason"
										class="text-xs text-error mt-1 max-w-[200px] truncate"
										:title="campaign.contentBlockReason"
									>
										{{ campaign.contentBlockReason }}
									</p>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center gap-1.5">
										<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
										<span class="text-text-secondary text-sm">
											{{ getAudienceText(campaign) }}
										</span>
									</div>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-secondary text-sm">
										{{
											campaign.status === 'scheduled'
												? formatDateTime(campaign.scheduledAt)
												: formatDate(campaign.sentAt)
										}}
									</span>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-secondary text-sm">
										{{ campaign.status === 'sent' ? getOpenRate(campaign) : '—' }}
									</span>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center justify-end gap-1" @click.stop>
										<!-- View Report (for sent campaigns) -->
										<button
											v-if="campaign.status === 'sent'"
											class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors"
											title="View Report"
											@click="handleViewReport(campaign._id)"
										>
											<Icon name="lucide:bar-chart-3" class="w-4 h-4" />
										</button>
										<!-- Edit (for draft/scheduled) -->
										<button
											v-if="campaign.status === 'draft' || campaign.status === 'scheduled'"
											class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
											title="Edit"
											@click="handleEdit(campaign._id)"
										>
											<Icon name="lucide:pencil" class="w-4 h-4" />
										</button>
										<!-- Duplicate -->
										<button
											class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
											title="Duplicate"
											@click="handleDuplicate(campaign._id)"
										>
											<Icon name="lucide:copy" class="w-4 h-4" />
										</button>
										<!-- More Actions Dropdown -->
										<UiDropdownMenu v-model:open="dropdownOpenStates[campaign._id]">
											<template #trigger>
												<button
													class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
												 aria-label="More actions">
													<Icon name="lucide:more-vertical" class="w-4 h-4" />
												</button>
											</template>
											<UiDropdownMenuItem
												v-if="campaign.status === 'sent'"
												icon="lucide:bar-chart-3"
												@click="handleViewReport(campaign._id)"
											>
												View Report
											</UiDropdownMenuItem>
											<UiDropdownMenuItem
												v-if="campaign.status === 'draft' || campaign.status === 'scheduled'"
												icon="lucide:pencil"
												@click="handleEdit(campaign._id)"
											>
												Edit
											</UiDropdownMenuItem>
											<UiDropdownMenuItem icon="lucide:copy" @click="handleDuplicate(campaign._id)">
												Duplicate
											</UiDropdownMenuItem>
											<UiDropdownDivider v-if="campaign.status !== 'sending'" />
											<UiDropdownMenuItem
												v-if="campaign.status !== 'sending'"
												icon="lucide:trash-2"
												danger
												@click="openDeleteModal(campaign._id, campaign.name)"
											>
												Delete
											</UiDropdownMenuItem>
										</UiDropdownMenu>
									</div>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
				<!-- Load More -->
				<div
					v-if="campaigns && campaigns.length > 0"
					class="flex items-center justify-center gap-4 px-6 py-4 border-t border-border-subtle"
				>
					<UiButton
						v-if="canLoadMore"
						variant="secondary"
						:loading="isLoadingMore"
						@click="handleLoadMore"
					>
						{{ isLoadingMore ? 'Loading...' : 'Load More' }}
					</UiButton>
					<span v-else-if="paginationStatus === 'Exhausted'" class="text-sm text-text-tertiary">
						All campaigns loaded
					</span>
				</div>
			</UiCard>
		</div>

		<!-- Delete Confirmation Modal -->
		<UiModal v-model:open="isDeleteModalOpen" title="Delete Campaign" :persistent="isDeleting">
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error/10 shrink-0 flex items-center justify-center">
					<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
				</div>
				<div>
					<p class="text-text-primary">
						Are you sure you want to delete
						<span class="font-semibold">"{{ campaignToDelete?.name }}"</span>?
					</p>
					<p class="text-sm text-text-secondary mt-2">
						This action cannot be undone. The campaign and its data will be permanently deleted.
					</p>
				</div>
			</div>
			<template #footer>
				<UiButton variant="secondary" :disabled="isDeleting" @click="closeDeleteModal">
					Cancel
				</UiButton>
				<UiButton variant="danger" :loading="isDeleting" @click="handleDelete">
					{{ isDeleting ? 'Deleting...' : 'Delete Campaign' }}
				</UiButton>
			</template>
		</UiModal>
	</div>
</template>
