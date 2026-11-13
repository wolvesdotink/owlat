<script setup lang="ts">
import { MinusIcon, TrendingDownIcon, TrendingUpIcon, type IconComponent } from '@coolicons/vue';

interface Props {
	label: string;
	value: string | number;
	icon: IconComponent;
	trend?: 'up' | 'down' | 'stable';
	description?: string;
	/**
	 * Whether a rising value is good news. Off for metrics where down is good
	 * (error rate, latency), so the colour follows the meaning, not the direction.
	 */
	upIsGood?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	trend: undefined,
	description: undefined,
	upIsGood: true,
});

const { t } = useI18n();

const trendConfig = computed(() => {
	if (!props.trend) return null;
	switch (props.trend) {
		case 'up':
			return { icon: TrendingUpIcon, color: props.upIsGood ? 'text-success' : 'text-error' };
		case 'down':
			return { icon: TrendingDownIcon, color: props.upIsGood ? 'text-error' : 'text-success' };
		case 'stable':
			return { icon: MinusIcon, color: 'text-text-tertiary' };
	}
});
</script>

<template>
	<UiCard>
		<div class="flex items-start justify-between mb-3">
			<UiIconBox :icon="icon" size="sm" variant="surface" />
			<div
				v-if="trendConfig && trend"
				class="flex items-center"
				:title="t(`components.agent.agentMetricCard.trend.${trend}`)"
			>
				<component
					:is="trendConfig.icon"
					class="w-4 h-4"
					:class="trendConfig.color"
					aria-hidden="true"
				/>
				<span class="sr-only">{{ t(`components.agent.agentMetricCard.trend.${trend}`) }}</span>
			</div>
		</div>
		<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary">{{ value }}</p>
		<p class="text-sm text-text-secondary mt-1">{{ label }}</p>
		<p v-if="description" class="text-xs text-text-tertiary mt-1">{{ description }}</p>
	</UiCard>
</template>
