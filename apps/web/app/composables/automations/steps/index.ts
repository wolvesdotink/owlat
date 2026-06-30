import { emailStepEditorModule } from './email';
import { delayStepEditorModule } from './delay';
import { conditionStepEditorModule } from './condition';
import type {
	StepEditorModule,
	StepEditorModuleMap,
	StepKind,
} from './types';

export const STEP_EDITOR_MODULES: StepEditorModuleMap = {
	email: emailStepEditorModule,
	delay: delayStepEditorModule,
	condition: conditionStepEditorModule,
};

export function stepEditorModuleFor<K extends StepKind>(
	kind: K
): StepEditorModuleMap[K] {
	return STEP_EDITOR_MODULES[kind];
}

export function listStepEditorModules(): StepEditorModule<StepKind>[] {
	return Object.values(STEP_EDITOR_MODULES) as StepEditorModule<StepKind>[];
}

export type {
	ConditionStepConfig,
	DelayStepConfig,
	EmailStepConfig,
	StepConfigByKind,
	StepConfigOfKind,
	StepDisplayContext,
	StepEditorModule,
	StepEditorModuleMap,
	StepKind,
} from './types';
