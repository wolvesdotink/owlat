<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Visualizations — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { data: visualizations, isLoading, error } = useConvexQuery(
	api.visualizationAgent.list,
	() => ({ limit: 50 }),
);
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-8">
			<h1 class="text-2xl font-semibold text-text-primary">Visualizations</h1>
			<p class="text-text-secondary mt-1">
				Generate interactive charts from natural language prompts. Use illustrative sample
				data for layout mockups, or pick a live dataset to chart your account's real numbers.
			</p>
		</div>

		<!-- Create prompt -->
		<div class="mb-8">
			<VisualizationsVisualizationPrompt />
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<div class="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin" />
				<p class="text-text-secondary text-sm">Loading visualizations...</p>
			</div>
		</div>

		<!-- Error -->
		<UiErrorAlert
			v-else-if="error"
			title="Couldn't load visualizations"
			message="We hit an error loading your visualizations. Reload the page to try again."
			class="my-8"
		/>

		<!-- Empty state -->
		<div
			v-else-if="!visualizations || visualizations.length === 0"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:bar-chart-3" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No visualizations yet</p>
			<p class="text-sm text-text-tertiary mt-1">
				Use the prompt above to generate your first visualization.
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
