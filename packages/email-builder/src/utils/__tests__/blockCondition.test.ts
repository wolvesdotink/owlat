import { describe, it, expect } from 'vitest';
import {
	normalizeCondition,
	conditionNeedsValue,
	conditionOperatorOptions,
	DEFAULT_CONDITION_OPERATOR,
} from '../blockCondition';
import type { BlockCondition } from '../../types';

describe('normalizeCondition', () => {
	it('always emits an operator so the renderer never falls through to default-show', () => {
		// Pre-fix bug: editor wrote only { variable }, leaving operator undefined.
		const result = normalizeCondition(undefined, { variable: 'coupon' });
		expect(result.operator).toBe(DEFAULT_CONDITION_OPERATOR);
		expect(result.operator).toBeDefined();
	});

	it('defaults a brand-new condition to "exists"', () => {
		expect(normalizeCondition(undefined, {}).operator).toBe('exists');
	});

	it('preserves the variable while changing the operator', () => {
		const result = normalizeCondition({ variable: 'plan', operator: 'exists' }, { operator: 'equals' });
		expect(result).toEqual({ variable: 'plan', operator: 'equals' });
	});

	it('keeps the value for value-operators (equals/notEquals/contains)', () => {
		const eq = normalizeCondition({ variable: 'plan', operator: 'exists' }, { operator: 'equals', value: 'pro' });
		expect(eq).toEqual({ variable: 'plan', operator: 'equals', value: 'pro' });

		const contains = normalizeCondition({ variable: 'tags' }, { operator: 'contains', value: 'vip' });
		expect(contains.value).toBe('vip');
	});

	it('drops a stale value when switching to a presence-operator (exists/notExists)', () => {
		const result = normalizeCondition(
			{ variable: 'plan', operator: 'equals', value: 'pro' },
			{ operator: 'exists' },
		);
		expect(result).toEqual({ variable: 'plan', operator: 'exists' });
		expect(result).not.toHaveProperty('value');
	});

	it('coerces a legacy operator-less condition into a complete one on the next edit', () => {
		// Simulates loading a block saved by the old operator-less editor.
		const legacy = { variable: 'coupon' } as Partial<BlockCondition>;
		const result = normalizeCondition(legacy, { variable: 'coupon' });
		expect(result.operator).toBe('exists');
	});
});

describe('conditionNeedsValue', () => {
	it.each(['equals', 'notEquals', 'contains'] as const)('is true for %s', (op) => {
		expect(conditionNeedsValue(op)).toBe(true);
	});

	it.each(['exists', 'notExists'] as const)('is false for %s', (op) => {
		expect(conditionNeedsValue(op)).toBe(false);
	});

	it('treats undefined as the default presence-operator (no value needed)', () => {
		expect(conditionNeedsValue(undefined)).toBe(false);
	});
});

describe('conditionOperatorOptions', () => {
	it('covers exactly the operators the renderer switches on', () => {
		const offered = conditionOperatorOptions.map((o) => o.value).sort();
		expect(offered).toEqual(['contains', 'equals', 'exists', 'notEquals', 'notExists']);
	});
});
