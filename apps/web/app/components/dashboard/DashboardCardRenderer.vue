<script setup lang="ts">
import { computed } from 'vue';
import { dashboardWidgetRegistry } from '~/composables/widgets/dashboardWidgets';
import { resolveWidget } from '~/composables/widgets/registry';

interface DashboardCardProps {
	card: {
		type: string;
		size: 'small' | 'medium' | 'large';
		pinned?: boolean;
	};
}

const props = defineProps<DashboardCardProps>();

const { isEnabled } = useFeatureFlag();

// Resolve the card type against the widget registry with the current flag state.
// - `ok`: render the card behind a per-widget isolation boundary.
// - `disabled`: a flag-gated widget whose flag is off — omit it entirely.
// - `unknown`: no renderer for this type — the "Unknown card type" affordance.
const resolution = computed(() =>
	resolveWidget(dashboardWidgetRegistry, props.card.type, isEnabled)
);

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
	<div v-if="resolution.status !== 'disabled'" :class="sizeClasses">
		<WidgetHost v-if="resolution.status === 'ok'" :module="resolution.module" />
		<UiCard v-else>
			<div class="flex items-center gap-2 text-text-tertiary">
				<Icon name="lucide:alert-circle" class="w-4 h-4" />
				<span class="text-sm">Unknown card type: {{ card.type }}</span>
			</div>
		</UiCard>
	</div>
</template>
