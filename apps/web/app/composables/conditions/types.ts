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

/**
 * A translatable sentence a module hands to whoever renders it.
 *
 * These modules are module-scope singletons — they are constructed before any
 * component sets up, so they cannot call `useI18n()`. They carry the message
 * *key* (and its interpolation params) instead, and the rendering component
 * resolves it with `t(text.key, text.params)`.
 */
export interface LocalizedText {
	readonly key: string;
	readonly params?: Record<string, string | number>;
}

export interface ConditionEditorModule<K extends ConditionKind> {
	readonly kind: K;
	/** i18n message key — resolve with `t()` at render time. */
	readonly label: string;
	/** i18n message key — resolve with `t()` at render time. */
	readonly description: string;
	createDefault(ctx: ConditionEditorContext): ConditionOfKind<K>;
	/** Returns an i18n message key for the failure, or `null` when valid. */
	validateForSubmit(condition: ConditionOfKind<K>): string | null;
	getDescription(condition: ConditionOfKind<K>, ctx: ConditionEditorContext): LocalizedText;
	readonly EditorComponent: Component;
}

export type ConditionEditorModuleMap = {
	[K in ConditionKind]: ConditionEditorModule<K>;
};
