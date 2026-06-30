<script setup lang="ts">
import { cardComponents } from './cardComponents';

interface DashboardCardProps {
	card: {
		type: string;
		size: 'small' | 'medium' | 'large';
		pinned?: boolean;
	};
}

const props = defineProps<DashboardCardProps>();

const resolvedComponent = computed(() => cardComponents[props.card.type] ?? null);

const sizeClasses = computed(() => {
	switch (props.card.size) {
		case 'large':
			return 'col-span-1 sm:col-span-2 lg:col-span-4';
		case 'medium':
			return 'col-span-1 sm:col-span-2';
		case 'small':
		default:
			return 'col-span-1';
	}
});
</script>

<template>
	<div :class="sizeClasses">
		<component
			:is="resolvedComponent"
			v-if="resolvedComponent"
		/>
		<UiCard v-else>
			<div class="flex items-center gap-2 text-text-tertiary">
				<Icon name="lucide:alert-circle" class="w-4 h-4" />
				<span class="text-sm">Unknown card type: {{ card.type }}</span>
			</div>
		</UiCard>
	</div>
</template>
