import { isRecord } from '@owlat/shared/utils/guards';
import { decodeJsonText, parserDecoder } from '@owlat/worker-protocol/decodeJson';
import {
	CONDITION_EDITOR_MODULES,
	conditionEditorModuleFor,
	provideConditionEditorContext,
	type Condition,
	type ConditionKind,
	type ConditionEditorContextInput,
} from './conditions';

// ─── Re-exports ────────────────────────────────────────────────────────────
export type { Condition, ConditionKind } from './conditions';

export type FilterLogic = 'AND' | 'OR';
export type FilterCondition = Condition;

export interface SegmentFilters {
	logic: FilterLogic;
	conditions: Condition[];
}

/** What a filter description says: how many conditions, and how they combine. */
interface FilterSummary {
	logic: FilterLogic | undefined;
	count: number;
}

/**
 * Stored filter JSON, read as far as its description needs: an object whose
 * `conditions` (absent: none) is a list of conditions, each an object with a
 * `kind`, and whose `logic` (absent: any) is AND or OR.
 */
const filterSummaryDecoder = parserDecoder((value): FilterSummary | null => {
	if (!isRecord(value)) return null;
	const { logic, conditions = [] } = value;
	if (logic !== undefined && logic !== 'AND' && logic !== 'OR') return null;
	if (!Array.isArray(conditions)) return null;
	if (!conditions.every((c) => isRecord(c) && typeof c['kind'] === 'string')) return null;
	return { logic, count: conditions.length };
}, '$: expected segment filters');

/**
 * Composable for managing segment filter configuration.
 *
 * Per-kind editor knowledge lives in the shared Condition editor modules
 * at `composables/conditions/<kind>/`. This composable provides the
 * Condition editor context to descendants, exposes a small registry-walk
 * API, and owns the condition CRUD operations on a SegmentFilters object.
 */
export function useSegmentFilters(ctx: ConditionEditorContextInput) {
	const { t } = useI18n();

	provideConditionEditorContext(ctx);

	const moduleList = Object.values(CONDITION_EDITOR_MODULES);

	const describeFilters = (filters: SegmentFilters | string): string => {
		let summary: FilterSummary;
		if (typeof filters === 'string') {
			const decoded = decodeJsonText(filters, filterSummaryDecoder);
			if (!decoded.ok) return t('shared.useSegmentFilters.invalidFilters');
			summary = decoded.value;
		} else {
			summary = { logic: filters.logic, count: filters.conditions?.length ?? 0 };
		}
		if (summary.count === 0) {
			return t('shared.useSegmentFilters.allContacts');
		}
		const { count } = summary;
		const logic = t(
			summary.logic === 'AND'
				? 'shared.useSegmentFilters.logicAll'
				: 'shared.useSegmentFilters.logicAny'
		);
		return t('shared.useSegmentFilters.conditionSummary', { count, logic }, count);
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
