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
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<UiPageHeader
			:title="t('dashboard.visualizations.title')"
			:description="t('dashboard.visualizations.intro')"
			class="mb-8"
		/>

		<!-- Create prompt. A form, so it keeps a form's width: at full width the
		     data-source select and Generate stretched across a 6K screen. -->
		<div class="mb-8 max-w-3xl">
			<VisualizationsVisualizationPrompt />
		</div>

		<!--
			Loading — the grid, at card geometry, not a centred spinner.

			`role="status"` + the existing loading copy as the accessible name keeps
			the announcement the spinner block carried, while the placeholders keep
			the grid geometry so nothing snaps when the query lands.
		-->
		<div
			v-if="isLoading"
			role="status"
			aria-busy="true"
			:aria-label="t('dashboard.visualizations.loading')"
			data-testid="visualizations-grid-skeleton"
			class="grid grid-cols-[repeat(auto-fill,minmax(min(28rem,100%),1fr))] gap-4"
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
		<div v-else class="grid grid-cols-[repeat(auto-fill,minmax(min(28rem,100%),1fr))] gap-4">
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
