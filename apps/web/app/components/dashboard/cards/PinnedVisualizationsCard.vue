<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

const { data: visualizations, isLoading } = useOrganizationQuery(api.visualizationAgent.listPinned);

interface Visualization {
	_id: string;
	title: string;
	html?: string;
	description?: string;
}

const pinnedList = computed<Visualization[]>(() => {
	return (visualizations.value as Visualization[] | null) ?? [];
});

const firstVisualization = computed(() => pinnedList.value[0] ?? null);
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:line-chart" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">
						{{ t('components.dashboard.cards.pinnedVisualizations.title') }}
					</h3>
				</div>
				<NuxtLink
					to="/dashboard/visualizations"
					class="text-xs font-medium text-brand hover:text-brand/80 transition-colors"
				>
					{{ t('common.viewAll') }}
				</NuxtLink>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else-if="!firstVisualization" class="py-6 text-center">
				<Icon name="lucide:line-chart" class="w-8 h-8 text-text-tertiary mx-auto mb-2" />
				<p class="text-sm text-text-secondary mb-1">
					{{ t('components.dashboard.cards.pinnedVisualizations.emptyTitle') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('components.dashboard.cards.pinnedVisualizations.emptyBody') }}
				</p>
			</div>

			<div v-else>
				<p class="text-sm font-medium text-text-primary mb-2 truncate">
					{{ firstVisualization.title }}
				</p>
				<div
					v-if="firstVisualization.html"
					class="rounded-lg overflow-hidden border border-border-subtle"
				>
					<VisualizationsVisualizationRenderer :html="firstVisualization.html" min-height="180px" />
				</div>
				<p v-else-if="firstVisualization.description" class="text-sm text-text-secondary">
					{{ firstVisualization.description }}
				</p>
				<p v-if="pinnedList.length > 1" class="text-xs text-text-tertiary mt-2">
					{{
						t('components.dashboard.cards.pinnedVisualizations.morePinned', {
							count: pinnedList.length - 1,
						})
					}}
				</p>
			</div>
		</div>
	</UiCard>
</template>
