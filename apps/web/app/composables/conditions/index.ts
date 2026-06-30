import { contactPropertyEditorModule } from './contact_property';
import { emailActivityEditorModule } from './email_activity';
import { topicMembershipEditorModule } from './topic_membership';
import type {
	ConditionEditorModule,
	ConditionEditorModuleMap,
	ConditionKind,
} from './types';

export const CONDITION_EDITOR_MODULES: ConditionEditorModuleMap = {
	contact_property: contactPropertyEditorModule,
	email_activity: emailActivityEditorModule,
	topic_membership: topicMembershipEditorModule,
};

export function conditionEditorModuleFor<K extends ConditionKind>(
	kind: K
): ConditionEditorModuleMap[K] {
	return CONDITION_EDITOR_MODULES[kind];
}

export function listConditionEditorModules(): ConditionEditorModule<ConditionKind>[] {
	return Object.values(CONDITION_EDITOR_MODULES) as ConditionEditorModule<ConditionKind>[];
}

export type {
	Condition,
	ConditionEditorContext,
	ConditionEditorModule,
	ConditionEditorModuleMap,
	ConditionKind,
	ConditionOfKind,
	ConditionVariant,
} from './types';

export {
	provideConditionEditorContext,
	useConditionEditorContext,
	type ConditionEditorContextInput,
} from './useConditionEditorContext';
