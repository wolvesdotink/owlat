<script setup lang="ts">
/**
 * The open step's settings. The page mounts it only while a step is selected,
 * so the canvas keeps its full width otherwise. Three placements:
 *
 * - `lg` and up: a column beside the canvas, its content sticky to the top of
 *   the viewport however far the canvas scrolls;
 * - `md` to `lg`: a sheet over the canvas from the right, with a scrim;
 * - below `md`: a full-height sheet with Back, the step title, the editor and
 *   the save line pinned to the bottom.
 *
 * While it is an overlay it behaves like `UiRailDrawer`: Escape (unless a
 * menu inside already claimed it) and the scrim close it, the phone's tab bar
 * steps aside, and focus moves into it on open. Closing always goes through
 * the page's `close`, which waits for the step's save first.
 */
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

const stepNumber = computed(
	() => props.mutableSteps.findIndex((step) => step._id === props.selectedStep?._id) + 1
);

const updateConfig = (config: StepConfigByKind[StepKind]) => {
	if (!props.currentConfig) return;
	emit('update:currentConfig', {
		kind: props.currentConfig.kind,
		config,
	} as StepCurrentConfig);
};

const isColumn = useMediaQuery('(min-width: 1024px)');
const isOverlay = computed(() => !isColumn.value);

// A menu inside the sheet that closed on this Escape has claimed it.
const onEscape = (event: KeyboardEvent) => {
	if (isOverlay.value && !event.defaultPrevented) emit('close');
};

// The phone's bottom tab bar runs to `lg` and outranks this sheet, so it steps
// aside while the sheet is an overlay (the same contract as UiRailDrawer).
const { setOpen: setRailDrawerOpen } = useRailDrawer();
watch(isOverlay, (overlay) => setRailDrawerOpen(overlay), { immediate: true });
onUnmounted(() => {
	if (isOverlay.value) setRailDrawerOpen(false);
});

// An overlay covers what had focus, so focus moves to its dismiss control.
const dismissButton = ref<HTMLElement | null>(null);
const backButton = ref<HTMLElement | null>(null);
onMounted(() => {
	if (!isOverlay.value) return;
	void nextTick(() => {
		const visible = [backButton.value, dismissButton.value].find((el) => el?.offsetParent);
		(visible ?? dismissButton.value)?.focus();
	});
});
</script>

<template>
	<Transition
		appear
		enter-active-class="transition-opacity duration-(--motion-moderate)"
		enter-from-class="opacity-0"
		enter-to-class="opacity-100"
		leave-active-class="transition-opacity duration-(--motion-moderate-exit)"
		leave-from-class="opacity-100"
		leave-to-class="opacity-0"
	>
		<div
			v-if="isOverlay"
			class="hidden md:block fixed inset-0 z-40 bg-scrim/50 lg:hidden"
			data-testid="step-panel-scrim"
			@click="emit('close')"
		/>
	</Transition>

	<aside
		class="fixed inset-0 z-50 flex flex-col bg-bg-elevated pt-[env(safe-area-inset-top)] md:left-auto md:w-96 md:border-l md:border-border-subtle md:shadow-xl lg:static lg:z-auto lg:shrink-0 lg:pt-0 lg:shadow-none"
		:aria-label="t('components.automations.stepEditorPanel.title')"
		data-testid="step-panel"
		@keydown.esc="onEscape"
	>
		<div
			v-if="selectedStep && currentConfig && module"
			class="flex flex-col h-full min-h-0 lg:sticky lg:top-0 lg:h-auto lg:max-h-dvh"
		>
			<header
				class="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-border-subtle md:px-6 md:py-4"
			>
				<button
					ref="backButton"
					type="button"
					class="md:hidden -ml-1 p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="t('common.back')"
					@click="emit('close')"
				>
					<Icon name="lucide:arrow-left" class="w-5 h-5" />
				</button>
				<div class="flex-1 min-w-0">
					<p class="text-xs font-medium text-text-tertiary uppercase tracking-wide">
						{{ t('dashboard.automations.detail.edit.stepNumber', { number: stepNumber }) }}
					</p>
					<h2 class="text-lg font-semibold text-text-primary truncate">
						{{ t(module.label) }}
					</h2>
				</div>
				<button
					ref="dismissButton"
					type="button"
					class="hidden md:inline-flex p-1.5 rounded-lg text-text-tertiary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="t('common.close')"
					@click="emit('close')"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</header>

			<div class="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
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
					<div class="flex flex-wrap gap-2 mt-3 pl-6">
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

				<div class="mt-8">
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

			<!-- Editors save on change; this line says whether that landed. -->
			<footer
				class="shrink-0 px-4 py-3 border-t border-border-subtle pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6"
			>
				<AutomationsStepSaveStatus live :status="saveStatus" @retry="emit('retry')" />
			</footer>
		</div>
	</aside>
</template>
