<script setup lang="ts">
import { api } from '@owlat/api';

const { data: inboundStats, isLoading } = useOrganizationQuery(api.inbox.queries.getInboundStats);

const pipelineStatus = computed(() => {
	if (!inboundStats.value) return 'unknown';
	const failed = inboundStats.value.failed ?? 0;
	const quarantined = inboundStats.value.quarantined ?? 0;
	const total = inboundStats.value.total ?? 0;
	if (total === 0) return 'idle';
	const errorRate = total > 0 ? (failed + quarantined) / total : 0;
	if (errorRate > 0.1) return 'degraded';
	if (failed > 0 || quarantined > 0) return 'warning';
	return 'healthy';
});

const statusConfig = computed(() => {
	switch (pipelineStatus.value) {
		case 'healthy':
			return { label: 'Healthy', variant: 'success' as const, icon: 'lucide:check-circle-2' };
		case 'warning':
			return { label: 'Warning', variant: 'warning' as const, icon: 'lucide:alert-triangle' };
		case 'degraded':
			return { label: 'Degraded', variant: 'error' as const, icon: 'lucide:alert-circle' };
		case 'idle':
			return { label: 'Idle', variant: 'neutral' as const, icon: 'lucide:pause-circle' };
		default:
			return { label: 'Unknown', variant: 'neutral' as const, icon: 'lucide:help-circle' };
	}
});

const metrics = computed(() => {
	if (!inboundStats.value) return [];
	const total = inboundStats.value.total ?? 0;
	const failed = inboundStats.value.failed ?? 0;
	const quarantined = inboundStats.value.quarantined ?? 0;
	const processing = inboundStats.value.processing ?? 0;
	return [
		{ label: 'Queue', value: processing, icon: 'lucide:layers' },
		{ label: 'Failed', value: failed, icon: 'lucide:x-circle' },
		{ label: 'Quarantined', value: quarantined, icon: 'lucide:shield-alert' },
		{ label: 'Total', value: total, icon: 'lucide:activity' },
	];
});
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:bot" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">Agent Health</h3>
				</div>
				<UiBadge :variant="statusConfig.variant" dot>
					{{ statusConfig.label }}
				</UiBadge>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else class="grid grid-cols-2 gap-2">
				<div
					v-for="metric in metrics"
					:key="metric.label"
					class="rounded-lg bg-bg-surface px-3 py-2"
				>
					<div class="flex items-center gap-1.5 mb-0.5">
						<Icon :name="metric.icon" class="w-3 h-3 text-text-tertiary" />
						<p class="text-xs text-text-tertiary">{{ metric.label }}</p>
					</div>
					<p class="text-lg font-semibold text-text-primary">{{ metric.value }}</p>
				</div>
			</div>
		</div>
	</UiCard>
</template>
