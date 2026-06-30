<script setup lang="ts">
interface Props {
	label: string;
	value: string | number;
	icon: string;
	trend?: 'up' | 'down' | 'stable';
	description?: string;
}

const props = defineProps<Props>();

const trendConfig = computed(() => {
	if (!props.trend) return null;
	switch (props.trend) {
		case 'up':
			return { icon: 'lucide:trending-up', color: 'text-success' };
		case 'down':
			return { icon: 'lucide:trending-down', color: 'text-error' };
		case 'stable':
			return { icon: 'lucide:minus', color: 'text-text-tertiary' };
	}
});
</script>

<template>
	<UiCard>
		<div class="flex items-start justify-between mb-3">
			<UiIconBox :icon="icon" size="sm" variant="surface" />
			<div v-if="trendConfig" class="flex items-center">
				<Icon :name="trendConfig.icon" class="w-4 h-4" :class="trendConfig.color" />
			</div>
		</div>
		<p class="text-2xl font-semibold text-text-primary">{{ value }}</p>
		<p class="text-sm text-text-secondary mt-1">{{ label }}</p>
		<p v-if="description" class="text-xs text-text-tertiary mt-1">{{ description }}</p>
	</UiCard>
</template>
