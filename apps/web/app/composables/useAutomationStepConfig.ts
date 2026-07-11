import { ref, computed, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
import { stepEditorModuleFor, type StepConfigByKind, type StepKind } from './automations/steps';

interface AutomationWithSteps {
	steps?: Doc<'automationSteps'>[];
}

export type StepCurrentConfig =
	| { kind: 'email'; config: StepConfigByKind['email'] }
	| { kind: 'delay'; config: StepConfigByKind['delay'] }
	| { kind: 'condition'; config: StepConfigByKind['condition'] }
	| null;

function parseStepConfigRaw(step: Doc<'automationSteps'>): unknown {
	if (typeof step.config === 'object' && step.config !== null) return step.config;
	try {
		return JSON.parse(step.config as string);
	} catch {
		return {};
	}
}

/**
 * Manages the currently-edited step's typed config.
 *
 * The editor exposes one discriminated `currentConfig` keyed by the
 * selected step's `kind`. Per-kind editor knowledge lives in
 * `composables/automations/steps/<kind>/` — this composable is a thin
 * walker over that registry.
 */
export function useAutomationStepConfig(
	selectedStepId: Ref<Id<'automationSteps'> | null>,
	automation: Ref<AutomationWithSteps | null | undefined>,
	showToast: (message: string, type?: 'success' | 'error') => void
) {
	const { run: updateStepMutation } = useBackendOperation(api.automations.steps.updateStep, {
		label: 'Update automation step',
	});

	const isSaving = ref(false);

	const currentConfig = ref<StepCurrentConfig>(null);

	// The selected step's config as last derived from (or persisted to) the
	// server, serialized for cheap comparison. `currentConfig` diverging from
	// this is what "unsaved step edits" means — re-derived whenever the selection
	// changes so switching to a step never starts out dirty.
	const persistedConfigJson = ref<string | null>(null);

	watch(
		[selectedStepId, () => automation.value?.steps],
		() => {
			if (!selectedStepId.value || !automation.value?.steps) {
				currentConfig.value = null;
				persistedConfigJson.value = null;
				return;
			}
			const step = automation.value.steps.find((s) => s._id === selectedStepId.value);
			if (!step) {
				currentConfig.value = null;
				persistedConfigJson.value = null;
				return;
			}
			const raw = parseStepConfigRaw(step);
			const kind = step.stepType as StepKind;
			const module = stepEditorModuleFor(kind);
			const parsed = {
				kind,
				config: module.parseConfig(raw),
			} as StepCurrentConfig;
			currentConfig.value = parsed;
			persistedConfigJson.value = JSON.stringify(parsed.config);
		},
		{ immediate: true }
	);

	// Whether the open step panel holds edits not yet persisted. Guards the
	// step-switch (which re-derives currentConfig and would drop them) and the
	// page's leave/back navigation.
	const isCurrentConfigDirty = computed(() => {
		if (!currentConfig.value || persistedConfigJson.value === null) return false;
		return JSON.stringify(currentConfig.value.config) !== persistedConfigJson.value;
	});

	const handleUpdateStepConfig = async (options?: { silent?: boolean }) => {
		if (!selectedStepId.value || !currentConfig.value) return;

		isSaving.value = true;

		try {
			const result = await updateStepMutation({
				stepId: selectedStepId.value,
				config: currentConfig.value.config as never,
			});
			if (result === undefined) return;
			// The step is now persisted; adopt it as the clean baseline so the
			// dirty guard clears without waiting for the automation query to reload.
			persistedConfigJson.value = JSON.stringify(currentConfig.value.config);
			if (!options?.silent) showToast('Step updated');
		} finally {
			isSaving.value = false;
		}
	};

	return {
		isSaving,
		currentConfig,
		isCurrentConfigDirty,
		parseStepConfig: parseStepConfigRaw,
		handleUpdateStepConfig,
	};
}
