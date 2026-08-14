<script setup lang="ts">
import { api } from '@owlat/api';

const emit = defineEmits<{
	created: [];
}>();

// Live-data datasets — mirror the allowlist in visualizationAgent.ts
// (DATASET_KEYS). Selecting one opts the chart into REAL account numbers; the
// default ('') keeps the illustrative sample-data path. `label` is a message
// key; the template renders it through `t()`.
const DATASET_OPTIONS = [
	{
		value: 'email_delivery_30d',
		label: 'components.visualizations.visualizationPrompt.datasets.emailDelivery30d',
	},
	{
		value: 'agent_health',
		label: 'components.visualizations.visualizationPrompt.datasets.agentHealth',
	},
	{
		value: 'contact_growth',
		label: 'components.visualizations.visualizationPrompt.datasets.contactGrowth',
	},
	{
		value: 'campaign_performance',
		label: 'components.visualizations.visualizationPrompt.datasets.campaignPerformance',
	},
] as const;

type DatasetValue = (typeof DATASET_OPTIONS)[number]['value'];

const { t } = useI18n();

const { run: createFromPrompt } = useBackendOperation(api.visualizationAgent.createFromPrompt, {
	label: () => t('components.visualizations.visualizationPrompt.createOperation'),
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
			<h3 class="text-lg font-medium text-text-primary">
				{{ t('components.visualizations.visualizationPrompt.title') }}
			</h3>
		</div>
		<I18nT
			keypath="components.visualizations.visualizationPrompt.intro"
			tag="p"
			scope="global"
			class="text-sm text-text-secondary mb-4"
		>
			<template #sampleData>
				<strong>{{ t('components.visualizations.visualizationPrompt.sampleDataName') }}</strong>
			</template>
		</I18nT>

		<div class="space-y-3">
			<textarea
				v-model="prompt"
				rows="3"
				class="input w-full resize-y"
				:placeholder="t('components.visualizations.visualizationPrompt.promptPlaceholder')"
				@keydown.meta.enter="handleCreate"
				@keydown.ctrl.enter="handleCreate"
			/>

			<div>
				<label class="block text-sm font-medium text-text-secondary mb-1" for="viz-dataset">
					{{ t('components.visualizations.visualizationPrompt.dataSourceLabel') }}
				</label>
				<select id="viz-dataset" v-model="dataset" class="input w-full">
					<option value="">
						{{ t('components.visualizations.visualizationPrompt.sampleDataOption') }}
					</option>
					<option v-for="opt in DATASET_OPTIONS" :key="opt.value" :value="opt.value">
						{{ t(opt.label) }}
					</option>
				</select>
				<p v-if="useLiveData" class="text-xs text-text-tertiary mt-1">
					{{ t('components.visualizations.visualizationPrompt.liveDataNote') }}
				</p>
			</div>

			<div class="flex items-center justify-between">
				<label class="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
					<input v-model="pinToBoard" type="checkbox" class="rounded border-border-subtle" />
					{{ t('components.visualizations.visualizationPrompt.pinToDashboard') }}
				</label>

				<UiButton class="gap-2" :disabled="!prompt.trim() || isCreating" @click="handleCreate">
					<UiSpinner v-if="isCreating" size="xs" tone="inverse" />
					<Icon v-else name="lucide:sparkles" class="w-4 h-4" />
					{{
						isCreating
							? t('components.visualizations.visualizationPrompt.generating')
							: t('components.visualizations.visualizationPrompt.generate')
					}}
				</UiButton>
			</div>
		</div>
	</div>
</template>
