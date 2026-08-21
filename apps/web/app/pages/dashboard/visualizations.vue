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

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">{{ t('dashboard.visualizations.loading') }}</p>
			</div>
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
		<div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
