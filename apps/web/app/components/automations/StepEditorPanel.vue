<script setup lang="ts">
import type { Id, Doc } from '@owlat/api/dataModel';
import { stepEditorModuleFor } from '~/composables/automations/steps';
import type { StepConfigByKind, StepKind } from '~/composables/automations/steps';
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

const { t } = useI18n();

const stepKind = computed<StepKind | null>(() => props.currentConfig?.kind ?? null);

const module = computed(() => (stepKind.value ? stepEditorModuleFor(stepKind.value) : null));

/** True while a step is open for editing (the panel's form is showing). */
const isEditing = computed(() => !!(props.selectedStep && props.currentConfig && module.value));

// Below lg the panel stacks under the canvas, so opening a step would change
// nothing on screen; bring the form into view instead. Desktop keeps the
// side-by-side layout and never scrolls.
const root = ref<HTMLElement | null>(null);
watch(
	() => props.selectedStep?._id,
	async (id) => {
		if (!id || !import.meta.client || window.matchMedia('(min-width: 1024px)').matches) return;
		await nextTick();
		root.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
);

const updateConfig = (config: StepConfigByKind[StepKind]) => {
	if (!props.currentConfig) return;
	emit('update:currentConfig', {
		kind: props.currentConfig.kind,
		config,
	} as StepCurrentConfig);
};
</script>

<template>
	<!-- From lg the column stretches to the full canvas height; the content sticks
	     to the top of the viewport so it stays in view however far the canvas
	     scrolls. Below lg a fixed 384px column left the canvas a sliver, so the
	     panel stacks under the canvas and only appears while a step is open. -->
	<div
		ref="root"
		class="w-full lg:w-96 shrink-0 border-t lg:border-t-0 lg:border-l border-border-subtle bg-bg-elevated scroll-mt-4"
		:class="isEditing ? '' : 'max-lg:hidden'"
	>
		<div class="lg:sticky lg:top-0 lg:max-h-dvh lg:overflow-y-auto">
			<div v-if="isEditing && selectedStep && currentConfig && module" class="p-6">
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
					<UiButton full-width class="gap-2" :disabled="isSaving" @click="emit('save')">
						<Icon
							v-if="isSaving"
							name="lucide:loader-2"
							class="w-4 h-4 animate-spin motion-reduce:animate-none"
						/>
						<Icon v-else name="lucide:save" class="w-4 h-4" />
						{{ isSaving ? t('common.saving') : t('components.automations.stepEditorPanel.save') }}
					</UiButton>
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
