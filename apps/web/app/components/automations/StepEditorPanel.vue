<script setup lang="ts">
import type { Id, Doc } from '@owlat/api/dataModel';
import { stepEditorModuleFor } from '~/composables/automations/steps';
import type {
	StepConfigByKind,
	StepKind,
} from '~/composables/automations/steps';
import type { StepCurrentConfig } from '~/composables/useAutomationStepConfig';

const props = defineProps<{
	selectedStep: (Doc<'automationSteps'> & { emailTemplate?: Doc<'emailTemplates'> | null }) | null;
	isSaving: boolean;
	emailTemplates: Doc<'emailTemplates'>[] | null | undefined;
	currentConfig: StepCurrentConfig;
	mutableSteps: Doc<'automationSteps'>[];
}>();

const emit = defineEmits<{
	close: [];
	save: [];
	delete: [stepId: Id<'automationSteps'>];
	'update:currentConfig': [value: StepCurrentConfig];
}>();

const stepKind = computed<StepKind | null>(() => props.currentConfig?.kind ?? null);

const module = computed(() => (stepKind.value ? stepEditorModuleFor(stepKind.value) : null));

const updateConfig = (config: StepConfigByKind[StepKind]) => {
	if (!props.currentConfig) return;
	emit('update:currentConfig', {
		kind: props.currentConfig.kind,
		config,
	} as StepCurrentConfig);
};
</script>

<template>
	<div class="w-96 border-l border-border-subtle bg-bg-elevated overflow-y-auto">
		<div v-if="selectedStep && currentConfig && module" class="p-6">
			<div class="flex items-center justify-between mb-6">
				<h2 class="text-lg font-semibold text-text-primary">Step Settings</h2>
				<button
					class="p-1.5 text-text-tertiary hover:text-text-primary transition-colors"
					@click="emit('close')"
				 aria-label="Close">
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</div>

			<!-- Per-kind editor (delegated to the step editor module) -->
			<component
				:is="module.EditorComponent"
				:model-value="currentConfig.config"
				:email-templates="emailTemplates"
				:mutable-steps="mutableSteps"
				:selected-step-id="selectedStep._id"
				@update:model-value="updateConfig"
				@save="emit('save')"
			/>

			<div class="mt-8 pt-6 border-t border-border-subtle">
				<button class="btn btn-primary w-full gap-2" :disabled="isSaving" @click="emit('save')">
					<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					<Icon v-else name="lucide:save" class="w-4 h-4" />
					{{ isSaving ? 'Saving...' : 'Save Changes' }}
				</button>
			</div>

			<div class="mt-4">
				<button
					class="btn btn-ghost w-full gap-2 text-error hover:bg-error/10"
					@click="emit('delete', selectedStep._id)"
				>
					<Icon name="lucide:trash-2" class="w-4 h-4" />
					Delete Step
				</button>
			</div>
		</div>

		<div v-else class="p-6 flex flex-col items-center justify-center h-full text-center">
			<div class="w-16 h-16 mb-4 rounded-full bg-bg-surface flex items-center justify-center">
				<Icon name="lucide:chevron-down" class="w-8 h-8 text-text-tertiary" />
			</div>
			<h3 class="text-lg font-semibold text-text-primary mb-2">Select a Step</h3>
			<p class="text-text-secondary">
				Click on a step in the workflow to configure its settings.
			</p>
		</div>
	</div>
</template>
