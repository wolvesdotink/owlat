import type { BlockCondition } from '../types';

export type ConditionOperator = BlockCondition['operator'];

/** Operators that compare the variable against a `value`. The rest only test presence. */
const VALUE_OPERATORS: readonly ConditionOperator[] = ['equals', 'notEquals', 'contains'];

export const conditionOperatorOptions: { label: string; value: ConditionOperator }[] = [
	{ label: 'Exists', value: 'exists' },
	{ label: 'Does not exist', value: 'notExists' },
	{ label: 'Equals', value: 'equals' },
	{ label: 'Not equals', value: 'notEquals' },
	{ label: 'Contains', value: 'contains' },
];

/** Default operator for a freshly-created condition (matches the most common "show if set" intent). */
export const DEFAULT_CONDITION_OPERATOR: ConditionOperator = 'exists';

/** Whether the given operator needs an accompanying `value` input. */
export function conditionNeedsValue(operator: ConditionOperator | undefined): boolean {
	return VALUE_OPERATORS.includes(operator ?? DEFAULT_CONDITION_OPERATOR);
}

/**
 * Merge an edit into an existing (possibly partial) condition and return a COMPLETE
 * BlockCondition. The renderer's evaluateCondition() switches on `operator`; if it is
 * missing the switch falls through to `default: return true` and the block is always
 * shown. So we always emit `variable` + `operator`, and only keep `value` for the
 * operators that use it.
 */
export function normalizeCondition(
	current: Partial<BlockCondition> | undefined,
	patch: Partial<BlockCondition>,
): BlockCondition {
	const merged = { ...(current ?? {}), ...patch };
	const operator = merged.operator ?? DEFAULT_CONDITION_OPERATOR;
	const next: BlockCondition = {
		variable: merged.variable ?? '',
		operator,
	};
	if (conditionNeedsValue(operator) && merged.value !== undefined) {
		next.value = merged.value;
	}
	return next;
}
