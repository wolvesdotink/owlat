<script setup lang="ts">
import { api } from '@owlat/api';
import { formatNumber } from '~/utils/formatters';

const { t, locale } = useI18n();

/**
 * Passed to UiNumberTicker, which formats every in-flight frame of the tween.
 * The ticker captures the formatter at setup, so the element is keyed on
 * `locale` in the template to re-render the current value on a language switch.
 */
function formatCount(value: number): string {
	return formatNumber(Math.round(value), locale.value);
}

const { data: stats, isLoading } = useOrganizationQuery(api.inbox.queries.getInboundStats);

const queueItems = computed(() => {
	if (!stats.value) return [];
	return [
		{
			id: 'received',
			label: t('components.dashboard.cards.queueDepthCard.stages.received'),
			count: stats.value.received ?? 0,
			color: 'bg-brand',
		},
		{
			id: 'processing',
			label: t('components.dashboard.cards.queueDepthCard.stages.processing'),
			count: stats.value.processing ?? 0,
			color: 'bg-warning',
		},
		{
			id: 'draftReady',
			label: t('components.dashboard.cards.queueDepthCard.stages.draftReady'),
			count: stats.value.draftReady ?? 0,
			color: 'bg-success',
		},
		{
			id: 'approved',
			label: t('components.dashboard.cards.queueDepthCard.stages.approved'),
			count: stats.value.approved ?? 0,
			color: 'bg-brand/60',
		},
	];
});

const totalInQueue = computed(() => {
	return queueItems.value.reduce((sum, item) => sum + item.count, 0);
});

const maxCount = computed(() => {
	return Math.max(...queueItems.value.map((item) => item.count), 1);
});
</script>

<template>
	<UiCard class="h-full" padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:layers" size="sm" variant="surface" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.queueDepthCard.title') }}
					</h3>
				</div>
			</div>

			<DashboardCardSkeleton v-if="isLoading" shape="stat" hero :count="4" />

			<div v-else>
				<div class="flex items-baseline gap-2 mb-4">
					<span class="text-3xl font-bold tabular-nums text-text-primary">
						<UiNumberTicker :key="locale" :value="totalInQueue" :formatter="formatCount" />
					</span>
					<span class="text-sm text-text-secondary">
						{{ t('components.dashboard.cards.queueDepthCard.messagesInPipeline') }}
					</span>
				</div>

				<div class="space-y-2.5">
					<div v-for="item in queueItems" :key="item.id">
						<div class="flex items-center justify-between mb-1">
							<span class="text-xs text-text-secondary">{{ item.label }}</span>
							<span class="text-xs font-medium tabular-nums text-text-primary">{{
								formatCount(item.count)
							}}</span>
						</div>
						<div class="h-1.5 bg-bg-surface rounded-full overflow-hidden">
							<div
								class="h-full rounded-full transition-all duration-(--motion-slow)"
								:class="item.color"
								:style="{ width: `${(item.count / maxCount) * 100}%` }"
							/>
						</div>
					</div>
				</div>
			</div>
		</div>
	</UiCard>
</template>
