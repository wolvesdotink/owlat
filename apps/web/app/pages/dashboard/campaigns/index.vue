<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Campaigns — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();

// Fetch campaign counts by status
const { data: statusCounts, isLoading: countsLoading } = useOrganizationQuery(
	api.campaigns.organization.countByStatusByOrganization
);

// Fetch active campaigns (scheduled, sending)
const {
	data: activeCampaigns,
	isLoading: activeLoading,
	error: activeError,
} = useOrganizationQuery(api.campaigns.analytics.getActiveByOrganization, { limit: 5 });

// Fetch send volume by day
const { data: sendVolume, isLoading: volumeLoading } = useOrganizationQuery(
	api.campaigns.analytics.getSendVolumeByDayByOrganization
);

// Fetch top performing campaigns
const {
	data: topCampaigns,
	isLoading: topLoading,
	error: topError,
} = useOrganizationQuery(api.campaigns.analytics.getTopPerformingByOrganization, { limit: 5 });

// Stats for display
const stats = computed(() => [
	{
		label: 'Total Campaigns',
		value: statusCounts.value?.['total'] ?? 0,
		icon: 'lucide:send',
		color: 'brand',
	},
	{
		label: 'Draft',
		value: statusCounts.value?.['draft'] ?? 0,
		icon: 'lucide:pencil',
		color: 'text-tertiary',
	},
	{
		label: 'Scheduled',
		value: statusCounts.value?.['scheduled'] ?? 0,
		icon: 'lucide:clock',
		color: 'brand',
	},
	{
		label: 'Sent',
		value: statusCounts.value?.['sent'] ?? 0,
		icon: 'lucide:check-circle',
		color: 'success',
	},
]);

// Quick actions
const quickActions = [
	{
		label: 'New Campaign',
		href: '/dashboard/campaigns/new',
		icon: 'lucide:plus',
		description: 'Create and send a new email campaign',
	},
	{
		label: 'View All Campaigns',
		href: '/dashboard/campaigns/all',
		icon: 'lucide:file-text',
		description: 'Browse all campaigns',
	},
	{
		label: 'Campaign Reports',
		href: '/dashboard/campaigns/reports',
		icon: 'lucide:bar-chart-3',
		description: 'View campaign analytics and reports',
	},
];

// Get status badge configuration
const { getStatusBadge } = useCampaignStatusBadge();

// Compact relative time ('3d ago' / 'in 3h'). Named distinctly from the
// auto-imported verbose formatRelativeTime so it cannot shadow it.
function formatCompactRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = timestamp - now; // Future time

	if (diff < 0) {
		// Past time
		const pastDiff = now - timestamp;
		const days = Math.floor(pastDiff / (24 * 60 * 60 * 1000));
		const hours = Math.floor(pastDiff / (60 * 60 * 1000));
		const minutes = Math.floor(pastDiff / (60 * 1000));

		if (days > 0) return `${days}d ago`;
		if (hours > 0) return `${hours}h ago`;
		if (minutes > 0) return `${minutes}m ago`;
		return 'Just now';
	}

	// Future time
	const days = Math.floor(diff / (24 * 60 * 60 * 1000));
	const hours = Math.floor(diff / (60 * 60 * 1000));
	const minutes = Math.floor(diff / (60 * 1000));

	if (days > 0) return `in ${days}d`;
	if (hours > 0) return `in ${hours}h`;
	if (minutes > 0) return `in ${minutes}m`;
	return 'Now';
}

// Per-day bars for the send-volume chart (UiBars)
const sendVolumeBars = computed(
	() =>
		sendVolume.value?.map((d: { label: string; count: number }) => ({
			label: d.label,
			value: d.count,
		})) ?? []
);

// Compute total sent in last 7 days
const totalSentLast7Days = computed(() => {
	if (!sendVolume.value) return 0;
	return sendVolume.value.reduce((sum: number, d: { count: number }) => sum + d.count, 0);
});

// Navigate handlers
const handleNewCampaign = () => router.push('/dashboard/campaigns/new');
const handleViewReport = (campaignId: Id<'campaigns'>) =>
	router.push(`/dashboard/campaigns/${campaignId}/report`);
const handleEditCampaign = (campaignId: Id<'campaigns'>) =>
	router.push(`/dashboard/campaigns/${campaignId}/edit`);
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Campaigns</h1>
				<p class="mt-1 text-text-secondary">Create, schedule, and track your email campaigns.</p>
			</div>
			<UiButton @click="handleNewCampaign">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				New Campaign
			</UiButton>
		</div>

		<!-- Stats Cards -->
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
			<UiCard v-for="stat in stats" :key="stat.label" hoverable>
				<div class="flex items-start justify-between">
					<div>
						<p class="text-sm text-text-secondary">{{ stat.label }}</p>
						<div class="flex items-center gap-2 mt-1">
							<p v-if="countsLoading" class="text-3xl font-semibold text-text-tertiary">--</p>
							<p v-else class="text-3xl font-semibold text-text-primary">
								{{ stat.value }}
							</p>
							<Icon
								v-if="countsLoading"
								name="lucide:loader-2"
								class="w-4 h-4 animate-spin text-text-tertiary"
							/>
						</div>
					</div>
					<UiIconBox
						:icon="stat.icon"
						:variant="
							stat.color === 'success' ? 'success' : stat.color === 'brand' ? 'brand' : 'surface'
						"
					/>
				</div>
			</UiCard>
		</div>

		<!-- Quick Actions -->
		<div class="mb-8">
			<h2 class="text-lg font-semibold text-text-primary mb-4">Quick Actions</h2>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<NuxtLink
					v-for="action in quickActions"
					:key="action.label"
					:to="action.href"
					class="group"
				>
					<UiCard hoverable clickable>
						<div class="flex items-center gap-4">
							<UiIconBox
								:icon="action.icon"
								class="group-hover:bg-brand group-hover:text-text-inverse transition-colors"
							/>
							<div>
								<p class="font-medium text-text-primary group-hover:text-brand transition-colors">
									{{ action.label }}
								</p>
								<p class="text-sm text-text-tertiary">{{ action.description }}</p>
							</div>
						</div>
					</UiCard>
				</NuxtLink>
			</div>
		</div>

		<!-- Two column layout -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
			<!-- Active Campaigns -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:activity" class="w-5 h-5 text-brand" />
						Active Campaigns
					</h2>
					<NuxtLink
						to="/dashboard/campaigns/all?status=scheduled"
						class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
					>
						View all
						<Icon name="lucide:arrow-right" class="w-3 h-3" />
					</NuxtLink>
				</div>
				<UiCard>
					<UiQueryBoundary
						:loading="activeLoading"
						:error="activeError"
						:empty="!activeCampaigns || activeCampaigns.length === 0"
					>
						<template #loading>
							<div class="flex items-center justify-center py-8">
								<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
							</div>
						</template>

						<!-- Empty state -->
						<template #empty>
							<UiEmptyState
								icon="lucide:calendar"
								title="No active campaigns"
								description="Schedule a campaign to see it here."
							>
								<template #action>
									<UiButton size="sm" @click="handleNewCampaign">
										<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
										Create Campaign
									</UiButton>
								</template>
							</UiEmptyState>
						</template>

						<!-- Campaigns list -->
						<div class="divide-y divide-border-subtle">
							<div
								v-for="campaign in activeCampaigns"
								:key="campaign._id"
								class="flex items-center gap-4 py-3 first:pt-0 last:pb-0 cursor-pointer hover:bg-bg-surface -mx-4 px-4 transition-colors"
								@click="handleEditCampaign(campaign._id)"
							>
								<div class="flex-1 min-w-0">
									<p class="text-sm text-text-primary truncate font-medium">
										{{ campaign.name }}
									</p>
									<div class="flex items-center gap-2 mt-0.5">
										<span
											:class="[
												'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium',
												getStatusBadge(campaign.status).color,
											]"
										>
											<Icon
												:name="getStatusBadge(campaign.status).icon"
												:class="['w-3 h-3', campaign.status === 'sending' ? 'animate-spin' : '']"
											/>
											{{ getStatusBadge(campaign.status).label }}
										</span>
										<span class="text-xs text-text-tertiary">
											{{
												campaign.status === 'scheduled'
													? formatCompactRelativeTime(campaign.scheduledAt!)
													: 'Sending now'
											}}
										</span>
									</div>
								</div>
								<span class="text-xs text-text-tertiary">
									{{ formatDateTime(campaign.scheduledAt) }}
								</span>
							</div>
						</div>
					</UiQueryBoundary>
				</UiCard>
			</div>

			<!-- Send Volume Chart (Last 7 Days) -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
						<Icon name="lucide:trending-up" class="w-5 h-5 text-brand" />
						Send Volume (7 days)
					</h2>
					<span class="text-sm text-text-secondary">
						{{ totalSentLast7Days.toLocaleString() }} emails
					</span>
				</div>
				<UiCard>
					<!-- Loading state -->
					<div v-if="volumeLoading" class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
					</div>

					<!-- Chart -->
					<UiBars
						v-else
						:data="sendVolumeBars"
						:height="132"
						:label-every="1"
						:format-value="(v: number) => `${v.toLocaleString()} emails`"
						aria-label="Emails sent per day over the last 7 days"
					/>
				</UiCard>
			</div>
		</div>

		<!-- Top Performing Campaigns -->
		<div>
			<div class="flex items-center justify-between mb-4">
				<h2 class="text-lg font-semibold text-text-primary flex items-center gap-2">
					<Icon name="lucide:bar-chart-3" class="w-5 h-5 text-brand" />
					Top Performing Campaigns
				</h2>
				<NuxtLink
					to="/dashboard/campaigns/reports"
					class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
				>
					View reports
					<Icon name="lucide:arrow-right" class="w-3 h-3" />
				</NuxtLink>
			</div>
			<UiCard>
				<UiQueryBoundary
					:loading="topLoading"
					:error="topError"
					:empty="!topCampaigns || topCampaigns.length === 0"
				>
					<template #loading>
						<div class="flex items-center justify-center py-8">
							<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
						</div>
					</template>

					<!-- Empty state -->
					<template #empty>
						<UiEmptyState
							icon="lucide:bar-chart-3"
							title="No sent campaigns yet"
							description="Send your first campaign to see performance metrics here."
						/>
					</template>

					<!-- Table -->
					<div class="overflow-x-auto -mx-4 -mb-4 mt-0">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th class="text-left px-4 py-3 text-sm font-medium text-text-secondary">
										Campaign
									</th>
									<th class="text-right px-4 py-3 text-sm font-medium text-text-secondary">
										Delivered
									</th>
									<th class="text-right px-4 py-3 text-sm font-medium text-text-secondary">
										Opened
									</th>
									<th class="text-right px-4 py-3 text-sm font-medium text-text-secondary">
										Open Rate
									</th>
									<th class="text-right px-4 py-3 text-sm font-medium text-text-secondary" />
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="campaign in topCampaigns"
									:key="campaign._id"
									class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors"
								>
									<td class="px-4 py-3">
										<div class="min-w-0">
											<p class="text-sm text-text-primary font-medium truncate">
												{{ campaign.name }}
											</p>
											<p v-if="campaign.sentAt" class="text-xs text-text-tertiary mt-0.5">
												Sent {{ formatCompactRelativeTime(campaign.sentAt) }}
											</p>
										</div>
									</td>
									<td class="px-4 py-3 text-right">
										<span class="text-sm text-text-secondary">
											{{ (campaign.statsDelivered || 0).toLocaleString() }}
										</span>
									</td>
									<td class="px-4 py-3 text-right">
										<span class="text-sm text-text-secondary">
											{{ (campaign.statsOpened || 0).toLocaleString() }}
										</span>
									</td>
									<td class="px-4 py-3 text-right">
										<span class="text-sm font-medium text-brand">
											{{ campaign.openRate.toFixed(1) }}%
										</span>
									</td>
									<td class="px-4 py-3 text-right">
										<button
											class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors"
											title="View Report"
											@click="handleViewReport(campaign._id)"
										>
											<Icon name="lucide:bar-chart-3" class="w-4 h-4" />
										</button>
									</td>
								</tr>
							</tbody>
						</table>
					</div>
				</UiQueryBoundary>
			</UiCard>
		</div>
	</div>
</template>
