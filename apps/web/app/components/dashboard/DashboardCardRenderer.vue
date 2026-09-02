<script setup lang="ts">
import { computed } from 'vue';
import { dashboardWidgetRegistry } from '~/composables/widgets/dashboardWidgets';
import { resolveWidget } from '~/composables/widgets/registry';
import { dashboardCardSpan } from '~/utils/dashboardGrid';

interface DashboardCardProps {
	card: {
		type: string;
		size: 'small' | 'medium' | 'large';
		pinned?: boolean;
	};
}

const props = defineProps<DashboardCardProps>();

const { isEnabled } = useFeatureFlag();

const { t } = useI18n();

// Resolve the card type against the widget registry with the current flag state.
// - `ok`: render the card behind a per-widget isolation boundary.
// - `disabled`: a flag-gated widget whose flag is off — omit it entirely.
// - `unknown`: no renderer for this type — the "Unknown card type" affordance.
const resolution = computed(() =>
	resolveWidget(dashboardWidgetRegistry, props.card.type, isEnabled)
);

// Shared with the first-load placeholder grid so the two lay out identically.
const sizeClasses = computed(() => dashboardCardSpan(props.card.size));
</script>

<template>
	<!--
		`h-full` runs the whole way down (cell → widget boundary → card shell) so
		every card in a grid row shares a bottom edge. The grid stretches the cell
		already; without the chain the `UiCard` inside only grows to its content and
		a row of sparse cards renders ragged.
	-->
	<div v-if="resolution.status !== 'disabled'" :class="[sizeClasses, 'h-full']">
		<WidgetHost v-if="resolution.status === 'ok'" class="h-full" :module="resolution.module" />
		<UiCard v-else class="h-full">
			<div class="flex items-center gap-2 text-text-tertiary">
				<Icon name="lucide:alert-circle" class="w-4 h-4" />
				<span class="text-sm">{{
					t('components.dashboard.dashboardCardRenderer.unknownCardType', { type: card.type })
				}}</span>
			</div>
		</UiCard>
	</div>
</template>
