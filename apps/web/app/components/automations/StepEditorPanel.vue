<script setup lang="ts">
import type { Id, Doc } from '@owlat/api/dataModel';
import { stepEditorModuleFor } from '~/composables/automations/steps';
import type { StepConfigByKind, StepKind } from '~/composables/automations/steps';
import type { StepCurrentConfig, StepSaveStatus } from '~/composables/useAutomationStepConfig';

const props = defineProps<{
	selectedStep: (Doc<'automationSteps'> & { emailTemplate?: Doc<'emailTemplates'> | null }) | null;
	saveStatus: StepSaveStatus;
	emailTemplates: Doc<'emailTemplates'>[] | null | undefined;
	currentConfig: StepCurrentConfig;
	mutableSteps: Doc<'automationSteps'>[];
}>();

const emit = defineEmits<{
	close: [];
	save: [];
	retry: [];
	'use-theirs': [];
	'keep-mine': [];
	delete: [stepId: Id<'automationSteps'>];
	'update:currentConfig': [value: StepCurrentConfig];
}>();

const { t } = useI18n();

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
	<!-- The column stretches to the full canvas height; the content sticks to the
	     top of the viewport so it stays in view however far the canvas scrolls. -->
	<div class="w-96 shrink-0 border-l border-border-subtle bg-bg-elevated">
		<div class="sticky top-0 max-h-dvh overflow-y-auto">
			<div v-if="selectedStep && currentConfig && module" class="p-6">
				<div class="flex items-center justify-between mb-6">
					<h2 class="text-lg font-semibold text-text-primary">
						{{ t('components.automations.stepEditorPanel.title') }}
					</h2>
					<button
						class="p-1.5 text-text-tertiary hover:text-text-primary transition-colors"
						@click="emit('close')"
						:aria-label="t('common.close')"
					>
						<Icon name="lucide:x" class="w-5 h-5" />
					</button>
				</div>

				<!-- The server copy changed under unsaved edits: never overwrite either
				     silently, and hold autosave until the member picks one. -->
				<div
					v-if="saveStatus === 'conflict'"
					role="alert"
					class="mb-6 p-3 rounded-lg bg-warning/10 border border-warning/20"
					data-testid="step-conflict"
				>
					<p class="flex items-start gap-2 text-sm text-text-primary">
						<Icon name="lucide:alert-triangle" class="w-4 h-4 text-warning shrink-0 mt-0.5" />
						{{ t('components.automations.stepEditorPanel.conflict.body') }}
					</p>
					<div class="flex gap-2 mt-3 pl-6">
						<UiButton size="sm" variant="secondary" @click="emit('use-theirs')">
							{{ t('components.automations.stepEditorPanel.conflict.useTheirs') }}
						</UiButton>
						<UiButton size="sm" variant="secondary" @click="emit('keep-mine')">
							{{ t('components.automations.stepEditorPanel.conflict.keepMine') }}
						</UiButton>
					</div>
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

				<!-- Editors save on change; this line says whether that landed. -->
				<div class="mt-8 pt-6 border-t border-border-subtle">
					<AutomationsStepSaveStatus live :status="saveStatus" @retry="emit('retry')" />
				</div>

				<div class="mt-4">
					<UiButton
						variant="ghost"
						full-width
						class="gap-2 text-error hover:bg-error/10"
						@click="emit('delete', selectedStep._id)"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						{{ t('components.automations.stepEditorPanel.delete') }}
					</UiButton>
				</div>
			</div>

			<div v-else class="px-6 py-16 flex flex-col items-center text-center">
				<div class="w-16 h-16 mb-4 rounded-full bg-bg-surface flex items-center justify-center">
					<Icon name="lucide:chevron-down" class="w-8 h-8 text-text-tertiary" />
				</div>
				<h3 class="text-lg font-semibold text-text-primary mb-2">
					{{ t('components.automations.stepEditorPanel.emptyTitle') }}
				</h3>
				<p class="text-text-secondary">
					{{ t('components.automations.stepEditorPanel.emptyBody') }}
				</p>
			</div>
		</div>
	</div>
</template>
