<script setup lang="ts">
import { MinusIcon, TrendingDownIcon, TrendingUpIcon, type IconComponent } from '@coolicons/vue';

interface Props {
	label: string;
	value: string | number;
	icon: IconComponent;
	trend?: 'up' | 'down' | 'stable';
	description?: string;
}

const props = defineProps<Props>();

const trendConfig = computed(() => {
	if (!props.trend) return null;
	switch (props.trend) {
		case 'up':
			return { icon: TrendingUpIcon, color: 'text-success' };
		case 'down':
			return { icon: TrendingDownIcon, color: 'text-error' };
		case 'stable':
			return { icon: MinusIcon, color: 'text-text-tertiary' };
	}
});
</script>

<template>
	<UiCard>
		<div class="flex items-start justify-between mb-3">
			<UiIconBox :icon="icon" size="sm" variant="surface" />
			<div v-if="trendConfig" class="flex items-center">
				<component :is="trendConfig.icon" class="w-4 h-4" :class="trendConfig.color" />
			</div>
		</div>
		<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary">{{ value }}</p>
		<p class="text-sm text-text-secondary mt-1">{{ label }}</p>
		<p v-if="description" class="text-xs text-text-tertiary mt-1">{{ description }}</p>
	</UiCard>
</template>
