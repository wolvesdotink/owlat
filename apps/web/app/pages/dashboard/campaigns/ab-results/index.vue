<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';

useHead({ title: 'A/B Test Results — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();

// Search and filter state
const searchQuery = ref('');
const statusFilter = ref<'all' | 'testing' | 'winner_selected' | 'pending'>('all');

// Fetch all A/B test campaigns. getABTestCampaignsByOrganization is an action
// (the per-variant breakdown only exists in emailSends), so it is loaded
// imperatively once auth is ready rather than subscribed reactively — the old
// reactive query re-executed on every emailSends write.
type AbCampaigns = FunctionReturnType<
	typeof api.campaigns.analytics.getABTestCampaignsByOrganization
>;
const { organizationId } = useOrganizationContext();
const { isPending, isAuthenticated } = useAuth();
const campaigns = ref<AbCampaigns | null>(null);
const { run: loadAbResults, isLoading: actionLoading } = useBackendOperation(
	api.campaigns.analytics.getABTestCampaignsByOrganization,
	{ label: 'Load A/B results', type: 'action' },
);
const isLoading = computed(() => actionLoading.value || campaigns.value === null);
let loadStarted = false;

// Commit only on success: useBackendOperation swallows throws and returns
// undefined, so coercing that to [] would render a permanent "no A/B tests"
// empty state for a user who actually has them. On a transient failure, retry
// with backoff (the action isn't a self-healing reactive subscription).
async function loadAbCampaigns(attempt = 0): Promise<void> {
	const res = await loadAbResults({});
	if (res !== undefined) {
		campaigns.value = res;
		return;
	}
	if (attempt < 3) {
		setTimeout(() => void loadAbCampaigns(attempt + 1), 1000 * (attempt + 1));
	}
}

watch(
	[isPending, isAuthenticated, organizationId] as const,
	([pending, authed, orgId]) => {
		if (pending || !authed || !orgId || loadStarted) return;
		loadStarted = true;
		void loadAbCampaigns();
	},
	{ immediate: true },
);

// Filtered campaigns
const filteredCampaigns = computed(() => {
	if (!campaigns.value) return [];

	let result = [...campaigns.value];

	// Apply search filter
	if (searchQuery.value.trim()) {
		const search = searchQuery.value.toLowerCase().trim();
		result = result.filter((c) => {
			const name = c.name.toLowerCase();
			const subject = (c.subject ?? '').toLowerCase();
			return name.includes(search) || subject.includes(search);
		});
	}

	// Apply status filter
	if (statusFilter.value !== 'all') {
		result = result.filter((c) => c.abStats.status === statusFilter.value);
	}

	return result;
});

// Summary statistics
const summaryStats = computed(() => {
	if (!campaigns.value || campaigns.value.length === 0) {
		return {
			total: 0,
			testing: 0,
			completed: 0,
			pending: 0,
		};
	}

	return {
		total: campaigns.value.length,
		testing: campaigns.value.filter((c) => c.abStats.status === 'testing').length,
		completed: campaigns.value.filter((c) => c.abStats.status === 'winner_selected').length,
		pending: campaigns.value.filter((c) => c.abStats.status === 'pending').length,
	};
});

// Status filter tabs
const statusTabs = [
	{ key: 'all' as const, label: 'All Tests' },
	{ key: 'testing' as const, label: 'In Progress' },
	{ key: 'winner_selected' as const, label: 'Completed' },
	{ key: 'pending' as const, label: 'Pending' },
];

// Get status badge
const getStatusBadge = (status: string | undefined) => {
	switch (status) {
		case 'testing':
			return { color: 'bg-warning/10 text-warning', icon: 'lucide:clock', label: 'Testing' };
		case 'winner_selected':
			return { color: 'bg-success/10 text-success', icon: 'lucide:trophy', label: 'Completed' };
		case 'pending':
			return { color: 'bg-text-tertiary/10 text-text-tertiary', icon: 'lucide:file-text', label: 'Pending' };
		default:
			return {
				color: 'bg-text-tertiary/10 text-text-tertiary',
				icon: 'lucide:alert-circle',
				label: 'Unknown',
			};
	}
};

// Get test type label
const getTestTypeLabel = (testType: string | undefined) => {
	switch (testType) {
		case 'subject':
			return 'Subject Line';
		case 'content':
			return 'Email Content';
		default:
			return 'Unknown';
	}
};

// Navigate to report
const viewReport = (campaignId: Id<'campaigns'>) => {
	router.push(`/dashboard/campaigns/${campaignId}/report`);
};

// Get winner difference (how much better the winner was)
const getWinnerDifference = (campaign: NonNullable<typeof campaigns.value>[number]) => {
	if (!campaign.abStats.winner) return null;

	const stats = campaign.abStats;
	const winnerStats = stats.winner === 'A' ? stats.variantA : stats.variantB;
	const loserStats = stats.winner === 'A' ? stats.variantB : stats.variantA;

	// Compare by winner criteria
	const criteria = stats.config?.winnerCriteria || 'open_rate';
	if (criteria === 'open_rate' || criteria === 'manual') {
		const diff = winnerStats.openRate - loserStats.openRate;
		return { metric: 'open rate', diff: diff.toFixed(1) };
	} else {
		const diff = winnerStats.clickRate - loserStats.clickRate;
		return { metric: 'click rate', diff: diff.toFixed(1) };
	}
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
						<Icon name="lucide:flask-conical" class="w-7 h-7 text-brand" />
						A/B Test Results
					</h1>
					<p class="mt-1 text-text-secondary">
						Track and compare A/B test performance across campaigns.
					</p>
				</div>
			</div>
		</div>

		<!-- Summary Stats -->
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:split" size="sm" rounded="lg" />
					<span class="text-sm text-text-secondary">Total Tests</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.total }}
				</p>
			</div>

			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:clock" size="sm" variant="warning" rounded="lg" />
					<span class="text-sm text-text-secondary">In Progress</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.testing }}
				</p>
			</div>

			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:trophy" size="sm" variant="success" rounded="lg" />
					<span class="text-sm text-text-secondary">Completed</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.completed }}
				</p>
			</div>

			<div class="card">
				<div class="flex items-center gap-3 mb-2">
					<UiIconBox icon="lucide:file-text" size="sm" variant="surface" rounded="lg" />
					<span class="text-sm text-text-secondary">Pending</span>
				</div>
				<p class="text-2xl font-semibold text-text-primary">
					{{ summaryStats.pending }}
				</p>
			</div>
		</div>

		<!-- Filters -->
		<div class="flex flex-col sm:flex-row gap-4 mb-6">
			<!-- Search -->
			<div class="relative flex-1 max-w-md">
				<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
				<input
					v-model="searchQuery"
					type="text"
					placeholder="Search tests..."
					class="input pl-10 w-full"
				/>
			</div>

			<!-- Status Tabs -->
			<div class="flex gap-2 overflow-x-auto">
				<button
					v-for="tab in statusTabs"
					:key="tab.key"
					:class="[
						'px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap',
						statusFilter === tab.key
							? 'bg-brand text-text-inverse'
							: 'bg-bg-surface text-text-secondary hover:text-text-primary',
					]"
					@click="statusFilter = tab.key"
				>
					{{ tab.label }}
					<span
						v-if="tab.key === 'all'"
						:class="[
							'ml-1.5 px-1.5 py-0.5 rounded text-xs',
							statusFilter === tab.key ? 'bg-white/20' : 'bg-bg-elevated',
						]"
					>
						{{ summaryStats.total }}
					</span>
				</button>
			</div>
		</div>

		<!-- Loading state -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<Icon name="lucide:loader-2" class="w-8 h-8 animate-spin text-brand" />
		</div>

		<!-- Empty state -->
		<div
			v-else-if="!campaigns || campaigns.length === 0"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:flask-conical" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No A/B tests yet</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create a campaign with A/B testing enabled to compare different versions of your emails.
			</p>
			<NuxtLink to="/dashboard/campaigns/new" class="btn btn-primary mt-6">
				Create Campaign
			</NuxtLink>
		</div>

		<!-- No search results -->
		<div
			v-else-if="filteredCampaigns.length === 0"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No tests found</p>
			<p class="text-sm text-text-tertiary mt-1">Try adjusting your search or filter.</p>
		</div>

		<!-- A/B Tests List -->
		<div v-else class="space-y-4">
			<div
				v-for="campaign in filteredCampaigns"
				:key="campaign._id"
				class="card hover:border-brand transition-colors cursor-pointer"
				@click="viewReport(campaign._id)"
			>
				<!-- Header -->
				<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
					<div class="flex items-center gap-3 min-w-0">
						<UiIconBox icon="lucide:split" size="sm" rounded="lg" />
						<div class="min-w-0">
							<h3 class="text-lg font-medium text-text-primary truncate">
								{{ campaign.name }}
							</h3>
							<div class="flex items-center gap-2 mt-0.5">
								<span class="text-sm text-text-tertiary">
									{{ getTestTypeLabel(campaign.abStats.config?.testType) }} Test
								</span>
								<span class="text-text-tertiary">·</span>
								<span class="text-sm text-text-tertiary">
									{{ formatDate(campaign.sentAt || campaign.updatedAt) }}
								</span>
							</div>
						</div>
					</div>

					<div class="flex items-center gap-3">
						<!-- Status badge -->
						<span
							:class="[
								'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
								getStatusBadge(campaign.abStats.status).color,
							]"
						>
							<Icon :name="getStatusBadge(campaign.abStats.status).icon" class="w-3.5 h-3.5" />
							{{ getStatusBadge(campaign.abStats.status).label }}
						</span>

						<!-- Winner badge -->
						<span
							v-if="campaign.abStats.winner"
							class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-success/10 text-success"
						>
							<Icon name="lucide:trophy" class="w-3.5 h-3.5" />
							Variant {{ campaign.abStats.winner }} Won
						</span>
					</div>
				</div>

				<!-- Variant Comparison -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<!-- Variant A -->
					<div
						:class="[
							'p-4 border rounded-lg',
							campaign.abStats.winner === 'A' ? 'border-brand bg-brand/5' : 'border-border-subtle',
						]"
					>
						<div class="flex items-center justify-between mb-3">
							<div class="flex items-center gap-2">
								<div
									class="w-8 h-8 rounded-full bg-brand/20 text-brand flex items-center justify-center font-bold text-sm"
								>
									A
								</div>
								<span class="font-medium text-text-primary">Variant A</span>
								<Icon v-if="campaign.abStats.winner === 'A'" name="lucide:trophy" class="w-4 h-4 text-success" />
							</div>
							<span class="text-sm text-text-tertiary">
								{{ campaign.abStats.variantA.sent.toLocaleString() }} sent
							</span>
						</div>
						<div class="grid grid-cols-2 gap-4">
							<div>
								<div class="flex items-center gap-1.5 text-sm text-text-secondary mb-1">
									<Icon name="lucide:eye" class="w-3.5 h-3.5" />
									Open Rate
								</div>
								<div class="flex items-center gap-2">
									<div class="flex-1 h-1.5 bg-bg-surface rounded-full overflow-hidden">
										<div
											class="h-full bg-brand rounded-full"
											:style="{ width: `${Math.min(campaign.abStats.variantA.openRate, 100)}%` }"
										/>
									</div>
									<span class="text-sm font-medium text-brand min-w-[3rem] text-right">
										{{ campaign.abStats.variantA.openRate.toFixed(1) }}%
									</span>
								</div>
							</div>
							<div>
								<div class="flex items-center gap-1.5 text-sm text-text-secondary mb-1">
									<Icon name="lucide:mouse-pointer-click" class="w-3.5 h-3.5" />
									Click Rate
								</div>
								<div class="flex items-center gap-2">
									<div class="flex-1 h-1.5 bg-bg-surface rounded-full overflow-hidden">
										<div
											class="h-full bg-warning rounded-full"
											:style="{ width: `${Math.min(campaign.abStats.variantA.clickRate, 100)}%` }"
										/>
									</div>
									<span class="text-sm font-medium text-warning min-w-[3rem] text-right">
										{{ campaign.abStats.variantA.clickRate.toFixed(1) }}%
									</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Variant B -->
					<div
						:class="[
							'p-4 border rounded-lg',
							campaign.abStats.winner === 'B' ? 'border-brand bg-brand/5' : 'border-border-subtle',
						]"
					>
						<div class="flex items-center justify-between mb-3">
							<div class="flex items-center gap-2">
								<div
									class="w-8 h-8 rounded-full bg-brand/20 text-brand flex items-center justify-center font-bold text-sm"
								>
									B
								</div>
								<span class="font-medium text-text-primary">Variant B</span>
								<Icon v-if="campaign.abStats.winner === 'B'" name="lucide:trophy" class="w-4 h-4 text-success" />
							</div>
							<span class="text-sm text-text-tertiary">
								{{ campaign.abStats.variantB.sent.toLocaleString() }} sent
							</span>
						</div>
						<div class="grid grid-cols-2 gap-4">
							<div>
								<div class="flex items-center gap-1.5 text-sm text-text-secondary mb-1">
									<Icon name="lucide:eye" class="w-3.5 h-3.5" />
									Open Rate
								</div>
								<div class="flex items-center gap-2">
									<div class="flex-1 h-1.5 bg-bg-surface rounded-full overflow-hidden">
										<div
											class="h-full bg-brand rounded-full"
											:style="{ width: `${Math.min(campaign.abStats.variantB.openRate, 100)}%` }"
										/>
									</div>
									<span class="text-sm font-medium text-brand min-w-[3rem] text-right">
										{{ campaign.abStats.variantB.openRate.toFixed(1) }}%
									</span>
								</div>
							</div>
							<div>
								<div class="flex items-center gap-1.5 text-sm text-text-secondary mb-1">
									<Icon name="lucide:mouse-pointer-click" class="w-3.5 h-3.5" />
									Click Rate
								</div>
								<div class="flex items-center gap-2">
									<div class="flex-1 h-1.5 bg-bg-surface rounded-full overflow-hidden">
										<div
											class="h-full bg-warning rounded-full"
											:style="{ width: `${Math.min(campaign.abStats.variantB.clickRate, 100)}%` }"
										/>
									</div>
									<span class="text-sm font-medium text-warning min-w-[3rem] text-right">
										{{ campaign.abStats.variantB.clickRate.toFixed(1) }}%
									</span>
								</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Winner Summary -->
				<div
					v-if="campaign.abStats.winner && getWinnerDifference(campaign)"
					class="mt-4 pt-4 border-t border-border-subtle flex items-center justify-between"
				>
					<div class="flex items-center gap-2 text-sm text-text-secondary">
						<Icon name="lucide:check-circle-2" class="w-4 h-4 text-success" />
						<span>
							Variant {{ campaign.abStats.winner }} won with
							<span class="font-medium text-success"
								>+{{ getWinnerDifference(campaign)!.diff }}%</span
							>
							higher {{ getWinnerDifference(campaign)!.metric }}
						</span>
					</div>
					<button
						class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors"
						title="View Full Report"
						@click.stop="viewReport(campaign._id)"
					>
						<Icon name="lucide:chevron-right" class="w-5 h-5" />
					</button>
				</div>

				<!-- In Progress Info -->
				<div
					v-else-if="campaign.abStats.status === 'testing'"
					class="mt-4 pt-4 border-t border-border-subtle flex items-center justify-between"
				>
					<div class="flex items-center gap-2 text-sm text-text-secondary">
						<Icon name="lucide:clock" class="w-4 h-4 text-warning" />
						<span>Test in progress. Results will be available once a winner is determined.</span>
					</div>
					<button
						class="p-2 rounded-lg text-text-tertiary hover:text-brand hover:bg-brand/10 transition-colors"
						title="View Full Report"
						@click.stop="viewReport(campaign._id)"
					>
						<Icon name="lucide:chevron-right" class="w-5 h-5" />
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
