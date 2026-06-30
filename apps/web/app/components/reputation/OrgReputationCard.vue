<script setup lang="ts">
const props = defineProps<{
	reputation: {
		bounceRate: number;
		complaintRate: number;
		riskLevel: string;
		totalSent: number;
		totalDelivered: number;
		totalBounced: number;
		totalComplaints: number;
	} | null;
}>();

const deliveryRate = computed(() => {
	if (!props.reputation || props.reputation.totalSent === 0) return 0;
	return props.reputation.totalDelivered / props.reputation.totalSent;
});

const metrics = computed(() => {
	if (!props.reputation) return [];
	return [
		{
			label: 'Bounce Rate',
			value: formatPercentage(props.reputation.bounceRate, 2),
			color: rateColor(props.reputation.bounceRate, BOUNCE_RATE_THRESHOLDS),
			icon: 'lucide:arrow-down-right',
			description: 'Keep below 2% for healthy delivery',
		},
		{
			label: 'Complaint Rate',
			value: formatPercentage(props.reputation.complaintRate, 2),
			color: rateColor(props.reputation.complaintRate, COMPLAINT_RATE_THRESHOLDS),
			icon: 'lucide:flag',
			description: 'Gmail/Yahoo reject above 0.3%',
		},
		{
			label: 'Total Sent',
			value: props.reputation.totalSent.toLocaleString(),
			color: 'text-text-primary',
			icon: 'lucide:send',
			description: 'Emails sent in the last 30 days',
		},
		{
			label: 'Delivery Rate',
			// No sends in the window → show "—" rather than an alarming red 0%.
			value: props.reputation.totalSent > 0 ? formatPercentage(deliveryRate.value, 2) : '—',
			color:
				props.reputation.totalSent === 0
					? 'text-text-tertiary'
					: deliveryRate.value >= 0.95
						? 'text-success'
						: deliveryRate.value >= 0.9
							? 'text-warning'
							: 'text-error',
			icon: 'lucide:check-circle',
			description: 'Successfully delivered emails',
		},
	];
});
</script>

<template>
	<UiCard>
		<div class="space-y-5">
			<!-- Header -->
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:activity" size="lg" variant="brand" rounded="xl" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">Sending Reputation</h2>
						<p class="text-sm text-text-secondary">Rolling 30-day metrics</p>
					</div>
				</div>
				<ReputationBadge v-if="reputation" :risk-level="reputation.riskLevel" />
			</div>

			<!-- Empty state -->
			<UiEmptyState
				v-if="!reputation"
				icon="lucide:bar-chart-3"
				title="No sending data yet"
				description="Reputation metrics will appear after you start sending emails."
			/>

			<!-- Metrics grid -->
			<div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
				<div
					v-for="metric in metrics"
					:key="metric.label"
					class="p-4 rounded-lg bg-bg-surface"
				>
					<div class="flex items-center gap-2 mb-1">
						<Icon :name="metric.icon" class="w-4 h-4 text-text-tertiary" />
						<p class="text-sm text-text-secondary">{{ metric.label }}</p>
					</div>
					<p :class="metric.color" class="text-2xl font-semibold">
						{{ metric.value }}
					</p>
					<p class="text-xs text-text-tertiary mt-1">{{ metric.description }}</p>
				</div>
			</div>
		</div>
	</UiCard>
</template>
