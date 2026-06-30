<script setup lang="ts">
defineProps<{
	domains: Array<{
		domain: string;
		riskLevel: string;
		bounceRate: number;
		complaintRate: number;
		totalSent: number;
		totalBounced: number;
		totalComplaints: number;
		domainStatus: string | null;
	}>;
}>();

function getStatusBadgeClass(status: string | null): string {
	switch (status) {
		case 'verified':
			return 'bg-success/10 text-success';
		case 'pending':
			return 'bg-warning/10 text-warning';
		case 'failed':
			return 'bg-error/10 text-error';
		case 'registering':
			return 'bg-brand/10 text-brand';
		default:
			return 'bg-bg-surface text-text-tertiary';
	}
}
</script>

<template>
	<UiCard>
		<div class="space-y-5">
			<!-- Header -->
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:globe" size="lg" variant="brand" rounded="xl" />
				<div>
					<h2 class="text-lg font-semibold text-text-primary">Domain Reputation</h2>
					<p class="text-sm text-text-secondary">Per-domain sending metrics (30-day rolling)</p>
				</div>
			</div>

			<!-- Empty state -->
			<UiEmptyState
				v-if="domains.length === 0"
				icon="lucide:globe"
				title="No domain data"
				description="Domain reputation metrics will appear after you start sending from verified domains."
			>
				<template #action>
					<NuxtLink to="/dashboard/settings/domains">
						<UiButton variant="secondary">
							<template #iconLeft>
								<Icon name="lucide:plus" class="w-4 h-4" />
							</template>
							Configure Domains
						</UiButton>
					</NuxtLink>
				</template>
			</UiEmptyState>

			<!-- Domain list -->
			<div v-else class="divide-y divide-border-subtle">
				<div
					v-for="domain in domains"
					:key="domain.domain"
					class="py-4 first:pt-0 last:pb-0"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1">
								<p class="text-sm font-medium text-text-primary truncate">
									{{ domain.domain }}
								</p>
								<span
									v-if="domain.domainStatus"
									:class="getStatusBadgeClass(domain.domainStatus)"
									class="text-xs px-2 py-0.5 rounded-full font-medium shrink-0"
								>
									{{ domain.domainStatus }}
								</span>
							</div>
							<div class="flex items-center gap-4 text-xs text-text-tertiary">
								<span>{{ domain.totalSent.toLocaleString() }} sent</span>
								<span :class="rateColor(domain.bounceRate, BOUNCE_RATE_THRESHOLDS)">
									{{ formatPercentage(domain.bounceRate, 2) }} bounced
								</span>
								<span :class="rateColor(domain.complaintRate, COMPLAINT_RATE_THRESHOLDS)">
									{{ formatPercentage(domain.complaintRate, 2) }} complaints
								</span>
							</div>
						</div>
						<ReputationBadge :risk-level="domain.riskLevel" size="sm" />
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
