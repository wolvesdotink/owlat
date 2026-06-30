import { defineAsyncComponent } from 'vue';
import {
	conditionEditorModuleFor,
	type Condition,
	type ConditionEditorContext,
} from '~/composables/conditions';
import type { ConditionStepConfig, StepEditorModule } from '../types';

function emptyContext(): ConditionEditorContext {
	return {
		contactProperties: { value: [] } as unknown as ConditionEditorContext['contactProperties'],
		topics: { value: [] } as unknown as ConditionEditorContext['topics'],
	};
}

/**
 * Validate a single branch target. `null` means "continue to the next step" and
 * is always valid; otherwise it must be an integer position inside the current
 * step range. Returns an error string for the activation panel, or `null`.
 */
function branchTargetError(
	label: string,
	target: number | null,
	stepCount: number
): string | null {
	if (target === null) return null;
	if (!Number.isInteger(target) || target < 0 || target >= stepCount) {
		return `Condition ${label} points at a step that no longer exists — pick a valid branch target`;
	}
	return null;
}

export const conditionStepEditorModule: StepEditorModule<'condition'> = {
	kind: 'condition',
	label: 'Condition',
	description: 'Branch based on contact criteria',
	color: 'warning',
	icon: 'lucide:git-branch',
	createDefault: () => ({
		condition: {
			kind: 'contact_property',
			field: '',
			operator: 'equals',
			value: '',
		},
		yesBranchStepIndex: null,
		noBranchStepIndex: null,
	}),
	parseConfig(raw): ConditionStepConfig {
		const r = (raw ?? {}) as Record<string, unknown>;
		const condition = (r['condition'] ?? {}) as Condition;
		const yes = (r['yesBranchStepIndex'] as number | null | undefined) ?? null;
		const no = (r['noBranchStepIndex'] as number | null | undefined) ?? null;
		return {
			condition,
			yesBranchStepIndex: yes,
			noBranchStepIndex: no,
		};
	},
	validateForActivation(config, ctx) {
		const module = conditionEditorModuleFor(config.condition.kind);
		const conditionError = (module.validateForSubmit as (c: Condition) => string | null)(
			config.condition
		);
		if (conditionError) return conditionError;
		// Branch targets are stored as array-position indices into the full step
		// list. Removing/reordering steps can leave an index dangling or out of
		// range; the runtime would then silently end the run early and drop the
		// contact. Flag it here so the "Fix these issues" panel surfaces it.
		const branchError =
			branchTargetError('"true" branch', config.yesBranchStepIndex, ctx.stepCount) ??
			branchTargetError('"false" branch', config.noBranchStepIndex, ctx.stepCount);
		return branchError;
	},
	getDescription(config) {
		const module = conditionEditorModuleFor(config.condition.kind);
		return (
			module.getDescription as (c: Condition, ctx: ConditionEditorContext) => string
		)(config.condition, emptyContext());
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../../components/automations/steps/condition/Editor.vue')
	),
};
