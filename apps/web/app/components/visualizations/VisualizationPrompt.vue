<script setup lang="ts">
import { api } from '@owlat/api';

const emit = defineEmits<{
	created: [];
}>();

// Live-data datasets — mirror the allowlist in visualizationAgent.ts
// (DATASET_KEYS). Selecting one opts the chart into REAL account numbers; the
// default ('') keeps the illustrative sample-data path.
const DATASET_OPTIONS = [
	{ value: 'email_delivery_30d', label: 'Email delivery — last 30 days' },
	{ value: 'agent_health', label: 'AI agent pipeline health' },
	{ value: 'contact_growth', label: 'Contact growth — last 30 days' },
	{ value: 'campaign_performance', label: 'Recent campaign performance' },
] as const;

type DatasetValue = (typeof DATASET_OPTIONS)[number]['value'];

const { run: createFromPrompt } = useBackendOperation(api.visualizationAgent.createFromPrompt, {
	label: 'Create visualization',
});

const prompt = ref('');
const pinToBoard = ref(false);
const dataset = ref<DatasetValue | ''>('');
const isCreating = ref(false);

const useLiveData = computed(() => dataset.value !== '');

const handleCreate = async () => {
	if (!prompt.value.trim()) return;
	isCreating.value = true;
	const result = await createFromPrompt({
		prompt: prompt.value.trim(),
		pinned: pinToBoard.value,
		// Only opt into live account data when a dataset is explicitly chosen.
		...(dataset.value !== '' ? { dataset: dataset.value } : {}),
	});
	isCreating.value = false;
	if (result === undefined) return;
	prompt.value = '';
	pinToBoard.value = false;
	dataset.value = '';
	emit('created');
};
</script>

<template>
	<div class="card">
		<div class="flex items-center gap-2 mb-4">
			<Icon name="lucide:sparkles" class="w-5 h-5 text-brand" />
			<h3 class="text-lg font-medium text-text-primary">Create Visualization</h3>
		</div>
		<p class="text-sm text-text-secondary mb-4">
			Describe a chart in natural language and the AI agent will generate an interactive component.
			Leave the data source on <strong>Illustrative sample data</strong> for a layout mockup, or
			pick one of the live datasets below to chart your account's real numbers.
		</p>

		<div class="space-y-3">
			<textarea
				v-model="prompt"
				rows="3"
				class="input w-full resize-y"
				placeholder="e.g., A bar chart of email delivery status"
				@keydown.meta.enter="handleCreate"
				@keydown.ctrl.enter="handleCreate"
			/>

			<div>
				<label class="block text-sm font-medium text-text-secondary mb-1" for="viz-dataset">
					Data source
				</label>
				<select id="viz-dataset" v-model="dataset" class="input w-full">
					<option value="">Illustrative sample data (no account data)</option>
					<option v-for="opt in DATASET_OPTIONS" :key="opt.value" :value="opt.value">
						{{ opt.label }}
					</option>
				</select>
				<p v-if="useLiveData" class="text-xs text-text-tertiary mt-1">
					This chart will use your account's real numbers for the selected dataset.
				</p>
			</div>

			<div class="flex items-center justify-between">
				<label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
					<input v-model="pinToBoard" type="checkbox" class="rounded border-border-subtle" />
					Pin to dashboard
				</label>

				<button
					class="btn btn-primary gap-2"
					:disabled="!prompt.trim() || isCreating"
					@click="handleCreate"
				>
					<UiSpinner v-if="isCreating" size="xs" tone="inverse" />
					<Icon v-else name="lucide:sparkles" class="w-4 h-4" />
					{{ isCreating ? 'Generating...' : 'Generate' }}
				</button>
			</div>
		</div>
	</div>
</template>
