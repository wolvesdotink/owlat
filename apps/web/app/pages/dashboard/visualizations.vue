<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.visualizations.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

const {
	data: visualizations,
	isLoading,
	error,
} = useConvexQuery(api.visualizationAgent.list, () => ({ limit: 50 }));
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-8">
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.visualizations.title') }}
			</h1>
			<p class="text-text-secondary mt-1">
				{{ t('dashboard.visualizations.intro') }}
			</p>
		</div>

		<!-- Create prompt -->
		<div class="mb-8">
			<VisualizationsVisualizationPrompt />
		</div>

		<!--
			Loading — the grid, at card geometry, not a centred spinner.

			`role="status"` + the existing loading copy as the accessible name keeps
			the announcement the spinner block carried, while the placeholders keep
			the two-column geometry so nothing snaps when the query lands.
		-->
		<div
			v-if="isLoading"
			role="status"
			aria-busy="true"
			:aria-label="t('dashboard.visualizations.loading')"
			data-testid="visualizations-grid-skeleton"
			class="grid grid-cols-1 lg:grid-cols-2 gap-4"
		>
			<VisualizationsVisualizationCardSkeleton v-for="n in 4" :key="`viz-placeholder-${n}`" />
		</div>

		<!-- Error -->
		<UiErrorAlert
			v-else-if="error"
			:title="t('dashboard.visualizations.errorTitle')"
			:message="t('dashboard.visualizations.errorMessage')"
			class="my-8"
		/>

		<!-- Empty state -->
		<div
			v-else-if="!visualizations || visualizations.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox
				icon="lucide:bar-chart-3"
				size="xl"
				variant="surface"
				rounded="full"
				class="mb-4"
			/>
			<p class="text-text-secondary font-medium">{{ t('dashboard.visualizations.emptyTitle') }}</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('dashboard.visualizations.emptyDescription') }}
			</p>
		</div>

		<!-- Visualizations grid -->
		<div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<VisualizationsVisualizationCard
				v-for="viz in visualizations"
				:key="viz._id"
				:id="viz._id"
				:title="viz.title"
				:description="viz.description"
				:html="viz.html"
				:pinned="viz.pinned"
				:created-at="viz.createdAt"
				:data-query="viz.dataQuery"
			/>
		</div>
	</div>
</template>
