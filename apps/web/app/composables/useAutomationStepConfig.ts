import { ref, watch, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
import {
	stepEditorModuleFor,
	type StepConfigByKind,
	type StepKind,
} from './automations/steps';

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

	watch(
		[selectedStepId, () => automation.value?.steps],
		() => {
			if (!selectedStepId.value || !automation.value?.steps) {
				currentConfig.value = null;
				return;
			}
			const step = automation.value.steps.find((s) => s._id === selectedStepId.value);
			if (!step) {
				currentConfig.value = null;
				return;
			}
			const raw = parseStepConfigRaw(step);
			const kind = step.stepType as StepKind;
			const module = stepEditorModuleFor(kind);
			currentConfig.value = {
				kind,
				config: module.parseConfig(raw),
			} as StepCurrentConfig;
		},
		{ immediate: true }
	);

	const handleUpdateStepConfig = async () => {
		if (!selectedStepId.value || !currentConfig.value) return;

		isSaving.value = true;

		try {
			const result = await updateStepMutation({
				stepId: selectedStepId.value,
				config: currentConfig.value.config as never,
			});
			if (result === undefined) return;
			showToast('Step updated');
		} finally {
			isSaving.value = false;
		}
	};

	return {
		isSaving,
		currentConfig,
		parseStepConfig: parseStepConfigRaw,
		handleUpdateStepConfig,
	};
}
