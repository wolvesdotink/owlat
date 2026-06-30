<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

interface CampaignReport {
	_id: Id<'campaigns'>;
	name: string;
	subject?: string | null;
	sentAt?: number;
	statsSent?: number;
	statsDelivered?: number;
	statsOpened?: number;
	statsClicked?: number;
	openRate: number;
	clickRate: number;
}

useHead({ title: 'Campaign Reports — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
useOrganizationContext();

// Search and sort state
const searchQuery = ref('');
const sortBy = ref<'sentAt' | 'openRate' | 'clickRate' | 'delivered'>('sentAt');
const sortOrder = ref<'desc' | 'asc'>('desc');

// Fetch all sent campaigns with pagination (uses session-based organization context)
const { results: campaigns, isLoading, error } = usePaginatedQuery(
	api.campaigns.campaigns.list,
	() => ({ status: 'sent' as const }),
	{ initialNumItems: 100 }
);

// Accurate org-wide totals for the summary cards, independent of the loaded page
// (summing the visible 100 rows under-counted orgs with more sent campaigns).
const { data: sentSummary } = useOrganizationQuery(api.campaigns.organization.getSentSummary);

// Computed sorted and filtered campaigns
const filteredCampaigns = computed(() => {
	if (!campaigns.value) return [];

	let result: CampaignReport[] = campaigns.value.map((campaign) => {
		const delivered = campaign.statsDelivered || 0;
		const opened = campaign.statsOpened || 0;
		const clicked = campaign.statsClicked || 0;
		return {
			...campaign,
			openRate: delivered > 0 ? (opened / delivered) * 100 : 0,
			clickRate: delivered > 0 ? (clicked / delivered) * 100 : 0,
		};
	});

	// Apply search filter
	if (searchQuery.value.trim()) {
		const search = searchQuery.value.toLowerCase().trim();
		result = result.filter((c) => {
			const name = c.name.toLowerCase();
			const subject = (c.subject ?? '').toLowerCase();
			return name.includes(search) || subject.includes(search);
		});
	}

	// Apply sorting
	result.sort((a, b) => {
		let comparison = 0;
		switch (sortBy.value) {
			case 'sentAt':
				comparison = (a.sentAt || 0) - (b.sentAt || 0);
				break;
			case 'openRate':
				comparison = a.openRate - b.openRate;
				break;
			case 'clickRate':
				comparison = a.clickRate - b.clickRate;
				break;
			case 'delivered':
				comparison = (a.statsDelivered || 0) - (b.statsDelivered || 0);
				break;
		}
		return sortOrder.value === 'desc' ? -comparison : comparison;
	});

	return result;
});

// Summary statistics — from the org-wide aggregate, not just the loaded page.
const summaryStats = computed(() => {
	const s = sentSummary.value;
	if (!s) {
		return { totalCampaigns: 0, totalSent: 0, avgOpenRate: 0, avgClickRate: 0 };
	}
	return {
		totalCampaigns: s.totalCampaigns,
		totalSent: s.totalSent,
		avgOpenRate: s.totalDelivered > 0 ? (s.totalOpened / s.totalDelivered) * 100 : 0,
		avgClickRate: s.totalDelivered > 0 ? (s.totalClicked / s.totalDelivered) * 100 : 0,
	};
});

// Toggle sort
const toggleSort = (field: typeof sortBy.value) => {
	if (sortBy.value === field) {
		sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
	} else {
		sortBy.value = field;
		sortOrder.value = 'desc';
	}
};

// Navigate to report
const viewReport = (campaignId: Id<'campaigns'>) => {
	router.push(`/dashboard/campaigns/${campaignId}/report`);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-8">
			<NuxtLink
				to="/dashboard/campaigns"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Campaigns
			</NuxtLink>
			<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
				<div>
					<h1 class="text-2xl font-semibold text-text-primary flex items-center gap-3">
						<Icon name="lucide:bar-chart-3" class="w-7 h-7 text-brand" />
						Campaign Reports
					</h1>
					<p class="mt-1 text-text-secondary">View performance metrics for all sent campaigns.</p>
				</div>
			</div>
		</div>

		<!-- Summary Stats -->
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:send" size="sm" rounded="lg" />
					<span class="text-sm text-text-secondary">Total Campaigns</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.totalCampaigns.toLocaleString() }}
				</p>
			</div>

			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:trending-up" size="sm" variant="success" rounded="lg" />
					<span class="text-sm text-text-secondary">Emails Sent</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.totalSent.toLocaleString() }}
				</p>
			</div>

			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:eye" size="sm" rounded="lg" />
					<span class="text-sm text-text-secondary">Avg Open Rate</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.avgOpenRate.toFixed(1) }}%
				</p>
			</div>

			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:mouse-pointer-click" size="sm" variant="warning" rounded="lg" />
					<span class="text-sm text-text-secondary">Avg Click Rate</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.avgClickRate.toFixed(1) }}%
				</p>
			</div>
		</div>

		<!-- Search -->
		<div class="mb-6">
			<div class="relative max-w-md">
				<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
				<input
					v-model="searchQuery"
					type="text"
					placeholder="Search campaigns..."
					class="input pl-10 w-full"
				/>
			</div>
		</div>

		<!-- Loading state -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<Icon name="lucide:loader-2" class="w-8 h-8 animate-spin text-brand" />
		</div>

		<!-- Error -->
		<UiErrorAlert
			v-else-if="error"
			title="Couldn't load campaign reports"
			message="We hit an error loading reports. Reload the page to try again."
			class="my-8"
		/>

		<!-- Empty state -->
		<div
			v-else-if="!campaigns || campaigns.length === 0"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:bar-chart-3" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No sent campaigns yet</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Once you send your first campaign, performance data will appear here.
			</p>
			<NuxtLink to="/dashboard/campaigns/new" class="btn btn-primary mt-6">
				Create Campaign
			</NuxtLink>
		</div>

		<!-- No search results -->
		<div
			v-else-if="filteredCampaigns.length === 0 && searchQuery.trim()"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No campaigns found</p>
			<p class="text-sm text-text-tertiary mt-1">Try adjusting your search query.</p>
		</div>

		<!-- Reports Table -->
		<div v-else class="card p-0 overflow-hidden">
			<div class="overflow-x-auto">
				<table class="w-full">
					<thead>
						<tr class="border-b border-border-subtle bg-bg-surface">
							<th class="text-left px-4 py-3 text-sm font-medium text-text-secondary">Campaign</th>
							<th
								class="text-right px-4 py-3 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
								@click="toggleSort('sentAt')"
							>
								<span class="inline-flex items-center gap-1">
									<Icon name="lucide:calendar" class="w-3.5 h-3.5" />
									Sent
									<Icon name="lucide:arrow-up-down"
										v-if="sortBy === 'sentAt'"
										:class="['w-3 h-3', sortOrder === 'asc' ? 'rotate-180' : '']"
									/>
								</span>
							</th>
							<th
								class="text-right px-4 py-3 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
								@click="toggleSort('delivered')"
							>
								<span class="inline-flex items-center gap-1">
									Delivered
									<Icon name="lucide:arrow-up-down"
										v-if="sortBy === 'delivered'"
										:class="['w-3 h-3', sortOrder === 'asc' ? 'rotate-180' : '']"
									/>
								</span>
							</th>
							<th
								class="text-right px-4 py-3 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
								@click="toggleSort('openRate')"
							>
								<span class="inline-flex items-center gap-1">
									<Icon name="lucide:eye" class="w-3.5 h-3.5" />
									Open Rate
									<Icon name="lucide:arrow-up-down"
										v-if="sortBy === 'openRate'"
										:class="['w-3 h-3', sortOrder === 'asc' ? 'rotate-180' : '']"
									/>
								</span>
							</th>
							<th
								class="text-right px-4 py-3 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
								@click="toggleSort('clickRate')"
							>
								<span class="inline-flex items-center gap-1">
									<Icon name="lucide:mouse-pointer-click" class="w-3.5 h-3.5" />
									Click Rate
									<Icon name="lucide:arrow-up-down"
										v-if="sortBy === 'clickRate'"
										:class="['w-3 h-3', sortOrder === 'asc' ? 'rotate-180' : '']"
									/>
								</span>
							</th>
							<th class="text-right px-4 py-3 text-sm font-medium text-text-secondary" />
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="campaign in filteredCampaigns"
							:key="campaign._id"
							class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer"
							@click="viewReport(campaign._id)"
						>
							<td class="px-4 py-4">
								<div class="min-w-0">
									<p class="text-sm text-text-primary font-medium truncate max-w-xs">
										{{ campaign.name }}
									</p>
									<p
										v-if="campaign.subject"
										class="text-xs text-text-tertiary truncate max-w-xs mt-0.5"
									>
										{{ campaign.subject }}
									</p>
								</div>
							</td>
							<td class="px-4 py-4 text-right">
								<span class="text-sm text-text-secondary">
									{{ formatDate(campaign.sentAt) }}
								</span>
							</td>
							<td class="px-4 py-4 text-right">
								<span class="text-sm text-text-secondary">
									{{ (campaign.statsDelivered || 0).toLocaleString() }}
								</span>
							</td>
							<td class="px-4 py-4 text-right">
								<div class="flex items-center justify-end gap-2">
									<div class="w-16 h-1.5 bg-bg-surface rounded-full overflow-hidden">
										<div
											class="h-full bg-brand rounded-full"
											:style="{ width: `${Math.min(campaign.openRate, 100)}%` }"
										/>
									</div>
									<span class="text-sm font-medium text-brand min-w-[3rem] text-right">
										{{ campaign.openRate.toFixed(1) }}%
									</span>
								</div>
							</td>
							<td class="px-4 py-4 text-right">
								<div class="flex items-center justify-end gap-2">
									<div class="w-16 h-1.5 bg-bg-surface rounded-full overflow-hidden">
										<div
											class="h-full bg-warning rounded-full"
											:style="{ width: `${Math.min(campaign.clickRate, 100)}%` }"
										/>
									</div>
									<span class="text-sm font-medium text-warning min-w-[3rem] text-right">
										{{ campaign.clickRate.toFixed(1) }}%
									</span>
								</div>
							</td>
							<td class="px-4 py-4 text-right">
								<button
									class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors"
									title="View Report"
									@click.stop="viewReport(campaign._id)"
								>
									<Icon name="lucide:chevron-right" class="w-4 h-4" />
								</button>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	</div>
</template>
