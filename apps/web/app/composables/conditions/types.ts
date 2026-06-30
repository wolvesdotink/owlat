import type { Component, ComputedRef } from 'vue';
import type { Doc } from '@owlat/api/dataModel';
import type {
	Condition,
	ConditionKind,
	ConditionOfKind,
} from '../../../../api/convex/conditions/types';

export type { Condition, ConditionKind, ConditionOfKind };

export type ConditionVariant = 'row' | 'panel';

export interface ConditionEditorContext {
	readonly contactProperties: ComputedRef<Doc<'contactProperties'>[]>;
	readonly topics: ComputedRef<Doc<'topics'>[]>;
}

export interface ConditionEditorModule<K extends ConditionKind> {
	readonly kind: K;
	readonly label: string;
	readonly description: string;
	createDefault(ctx: ConditionEditorContext): ConditionOfKind<K>;
	validateForSubmit(condition: ConditionOfKind<K>): string | null;
	getDescription(condition: ConditionOfKind<K>, ctx: ConditionEditorContext): string;
	readonly EditorComponent: Component;
}

export type ConditionEditorModuleMap = {
	[K in ConditionKind]: ConditionEditorModule<K>;
};
