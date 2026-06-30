import {
	CONDITION_EDITOR_MODULES,
	conditionEditorModuleFor,
	provideConditionEditorContext,
	type Condition,
	type ConditionKind,
	type ConditionEditorContextInput,
} from './conditions';

// ─── Re-exports ────────────────────────────────────────────────────────────
export type {
	Condition,
	ConditionKind,
} from './conditions';

export type FilterLogic = 'AND' | 'OR';
export type FilterCondition = Condition;

export interface SegmentFilters {
	logic: FilterLogic;
	conditions: Condition[];
}

/**
 * Composable for managing segment filter configuration.
 *
 * Per-kind editor knowledge lives in the shared Condition editor modules
 * at `composables/conditions/<kind>/`. This composable provides the
 * Condition editor context to descendants, exposes a small registry-walk
 * API, and owns the condition CRUD operations on a SegmentFilters object.
 */
export function useSegmentFilters(ctx: ConditionEditorContextInput) {
	provideConditionEditorContext(ctx);

	const moduleList = Object.values(CONDITION_EDITOR_MODULES);

	const describeFilters = (filters: SegmentFilters | string): string => {
		let parsed: SegmentFilters;
		if (typeof filters === 'string') {
			try {
				parsed = JSON.parse(filters);
			} catch {
				return 'Invalid filters';
			}
		} else {
			parsed = filters;
		}
		if (!parsed.conditions || parsed.conditions.length === 0) {
			return 'All contacts';
		}
		const count = parsed.conditions.length;
		const logic = parsed.logic === 'AND' ? 'all' : 'any';
		return `${count} condition${count !== 1 ? 's' : ''} (${logic})`;
	};

	const editorCtx = {
		contactProperties: ctx.contactProperties,
		topics: ctx.topics,
	};

	const buildDefault = (kind: ConditionKind): Condition =>
		CONDITION_EDITOR_MODULES[kind].createDefault({
			contactProperties: editorCtx.contactProperties as never,
			topics: editorCtx.topics as never,
		} as never) as Condition;

	const addCondition = (filters: SegmentFilters) => {
		filters.conditions.push(buildDefault('topic_membership'));
	};

	const removeCondition = (filters: SegmentFilters, index: number) => {
		filters.conditions.splice(index, 1);
	};

	const updateConditionAt = (filters: SegmentFilters, index: number, next: Condition) => {
		filters.conditions.splice(index, 1, next);
	};

	const validateCondition = (condition: Condition): string | null => {
		const module = conditionEditorModuleFor(condition.kind);
		return (module.validateForSubmit as (c: Condition) => string | null)(condition);
	};

	return {
		moduleList,
		describeFilters,
		addCondition,
		removeCondition,
		updateConditionAt,
		validateCondition,
	};
}
