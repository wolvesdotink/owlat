<script setup lang="ts">
import { api } from '@owlat/api';
import {
	ActivityIcon,
	CircleCheckIcon,
	CircleCloseIcon,
	CircleHelpIcon,
	CirclePauseIcon,
	CircleWarningIcon,
	LayersIcon,
	RobotIcon,
	ShieldWarningIcon,
	TriangleWarningIcon,
} from '@coolicons/vue';

const { t } = useI18n();

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
			return {
				label: t('components.dashboard.cards.agentHealth.status.healthy'),
				variant: 'success' as const,
				icon: CircleCheckIcon,
			};
		case 'warning':
			return {
				label: t('components.dashboard.cards.agentHealth.status.warning'),
				variant: 'warning' as const,
				icon: TriangleWarningIcon,
			};
		case 'degraded':
			return {
				label: t('components.dashboard.cards.agentHealth.status.degraded'),
				variant: 'error' as const,
				icon: CircleWarningIcon,
			};
		case 'idle':
			return {
				label: t('components.dashboard.cards.agentHealth.status.idle'),
				variant: 'neutral' as const,
				icon: CirclePauseIcon,
			};
		default:
			return {
				label: t('common.unknown'),
				variant: 'neutral' as const,
				icon: CircleHelpIcon,
			};
	}
});

const metrics = computed(() => {
	if (!inboundStats.value) return [];
	const total = inboundStats.value.total ?? 0;
	const failed = inboundStats.value.failed ?? 0;
	const quarantined = inboundStats.value.quarantined ?? 0;
	const processing = inboundStats.value.processing ?? 0;
	return [
		{
			label: t('components.dashboard.cards.agentHealth.metrics.queue'),
			value: processing,
			icon: LayersIcon,
		},
		{
			label: t('components.dashboard.cards.agentHealth.metrics.failed'),
			value: failed,
			icon: CircleCloseIcon,
		},
		{
			label: t('components.dashboard.cards.agentHealth.metrics.quarantined'),
			value: quarantined,
			icon: ShieldWarningIcon,
		},
		{
			label: t('components.dashboard.cards.agentHealth.metrics.total'),
			value: total,
			icon: ActivityIcon,
		},
	];
});
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox :icon="RobotIcon" size="sm" variant="surface" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.agentHealth.title') }}
					</h3>
				</div>
				<UiBadge :variant="statusConfig.variant" dot>
					{{ statusConfig.label }}
				</UiBadge>
			</div>

			<DashboardCardSkeleton v-if="isLoading" shape="metrics" :count="4" />

			<div v-else class="grid grid-cols-2 gap-2">
				<div
					v-for="metric in metrics"
					:key="metric.label"
					class="rounded-lg bg-bg-surface px-3 py-2"
				>
					<div class="flex items-center gap-1.5 mb-0.5">
						<component :is="metric.icon" class="w-3 h-3 text-text-tertiary" />
						<p class="text-xs text-text-tertiary">{{ metric.label }}</p>
					</div>
					<p class="text-lg font-semibold tabular-nums text-text-primary">{{ metric.value }}</p>
				</div>
			</div>
		</div>
	</UiCard>
</template>
