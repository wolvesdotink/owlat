import { computed, inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { Doc } from '@owlat/api/dataModel';
import type { ConditionEditorContext } from './types';

const CONDITION_EDITOR_CONTEXT_KEY: InjectionKey<ConditionEditorContext> = Symbol(
	'ConditionEditorContext'
);

const EMPTY_CONTEXT: ConditionEditorContext = {
	contactProperties: computed(() => [] as Doc<'contactProperties'>[]),
	topics: computed(() => [] as Doc<'topics'>[]),
};

export interface ConditionEditorContextInput {
	contactProperties: Ref<Doc<'contactProperties'>[] | null | undefined> | ComputedRef<Doc<'contactProperties'>[] | null | undefined>;
	topics: Ref<Doc<'topics'>[] | null | undefined> | ComputedRef<Doc<'topics'>[] | null | undefined>;
}

/**
 * Provide the reactive reference data Condition editor modules need.
 * Call from a top-level consumer (segment modal page, automation step
 * editor page) once; modules inject the context via `useConditionEditorContext()`.
 */
export function provideConditionEditorContext(input: ConditionEditorContextInput): void {
	provide(CONDITION_EDITOR_CONTEXT_KEY, {
		contactProperties: computed(() => input.contactProperties.value ?? []),
		topics: computed(() => input.topics.value ?? []),
	});
}

/**
 * Read the Condition editor context provided by an ancestor consumer.
 * Falls back to an empty context when no provider exists — keeps stories,
 * isolated component tests, and the registry-walk uses (kind picker
 * dropdown) safe.
 */
export function useConditionEditorContext(): ConditionEditorContext {
	return inject(CONDITION_EDITOR_CONTEXT_KEY, EMPTY_CONTEXT);
}
