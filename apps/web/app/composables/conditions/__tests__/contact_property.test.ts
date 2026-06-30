import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import type { Doc } from '@owlat/api/dataModel';
import { contactPropertyEditorModule } from '../contact_property';
import {
	operatorsForField,
	operatorNeedsValue,
} from '../contact_property';
import type { ConditionEditorContext } from '../types';

const makeCtx = (
	contactProperties: Doc<'contactProperties'>[] = []
): ConditionEditorContext => ({
	contactProperties: computed(() => contactProperties),
	topics: computed(() => []),
});

const stringProp = {
	_id: 'p1' as never,
	key: 'company',
	label: 'Company',
	type: 'string',
} as unknown as Doc<'contactProperties'>;

const numberProp = {
	_id: 'p2' as never,
	key: 'lifetime_value',
	label: 'LTV',
	type: 'number',
} as unknown as Doc<'contactProperties'>;

const boolProp = {
	_id: 'p3' as never,
	key: 'is_vip',
	label: 'VIP',
	type: 'boolean',
} as unknown as Doc<'contactProperties'>;

describe('contactPropertyEditorModule', () => {
	it('createDefault returns a canonical contact_property condition', () => {
		expect(contactPropertyEditorModule.createDefault(makeCtx())).toEqual({
			kind: 'contact_property',
			field: '',
			operator: 'equals',
			value: '',
		});
	});

	describe('validateForSubmit', () => {
		it('flags missing field', () => {
			expect(
				contactPropertyEditorModule.validateForSubmit({
					kind: 'contact_property',
					field: '',
					operator: 'equals',
					value: 'x',
				})
			).toBe('Please select a property');
		});

		it('flags missing value for value-requiring operators', () => {
			expect(
				contactPropertyEditorModule.validateForSubmit({
					kind: 'contact_property',
					field: 'company',
					operator: 'equals',
					value: '',
				})
			).toBe('Please enter a value');
		});

		it('allows empty value for is_empty / not_empty / is_true / is_false', () => {
			for (const operator of ['is_empty', 'not_empty', 'is_true', 'is_false'] as const) {
				expect(
					contactPropertyEditorModule.validateForSubmit({
						kind: 'contact_property',
						field: 'company',
						operator,
						value: '',
					})
				).toBeNull();
			}
		});

		it('passes when field and (when needed) value are set', () => {
			expect(
				contactPropertyEditorModule.validateForSubmit({
					kind: 'contact_property',
					field: 'company',
					operator: 'equals',
					value: 'Acme',
				})
			).toBeNull();
		});
	});

	describe('operatorsForField', () => {
		it('returns string operators for string custom properties', () => {
			const ops = operatorsForField('company', [stringProp]);
			expect(ops.map((o) => o.value)).toContain('contains');
			expect(ops.map((o) => o.value)).not.toContain('gt');
		});

		it('returns number operators for number properties', () => {
			const ops = operatorsForField('lifetime_value', [numberProp]);
			expect(ops.map((o) => o.value)).toContain('gt');
			expect(ops.map((o) => o.value)).not.toContain('contains');
		});

		it('returns boolean operators for boolean properties', () => {
			const ops = operatorsForField('is_vip', [boolProp]);
			expect(ops.map((o) => o.value)).toEqual(['is_true', 'is_false']);
		});

		it('treats built-in fields (email/firstName/etc.) as strings', () => {
			const ops = operatorsForField('email', []);
			expect(ops.map((o) => o.value)).toContain('contains');
		});
	});

	describe('operatorNeedsValue', () => {
		it('returns false for value-less operators', () => {
			expect(operatorNeedsValue('is_empty')).toBe(false);
			expect(operatorNeedsValue('not_empty')).toBe(false);
			expect(operatorNeedsValue('is_true')).toBe(false);
			expect(operatorNeedsValue('is_false')).toBe(false);
		});

		it('returns true for value-requiring operators', () => {
			expect(operatorNeedsValue('equals')).toBe(true);
			expect(operatorNeedsValue('gt')).toBe(true);
			expect(operatorNeedsValue('contains')).toBe(true);
		});
	});

	describe('getDescription', () => {
		it('returns "Select a property" when field is empty', () => {
			expect(
				contactPropertyEditorModule.getDescription(
					{ kind: 'contact_property', field: '', operator: 'equals', value: '' },
					makeCtx()
				)
			).toBe('Select a property');
		});

		it('uses property label from context when available', () => {
			expect(
				contactPropertyEditorModule.getDescription(
					{ kind: 'contact_property', field: 'company', operator: 'equals', value: 'Acme' },
					makeCtx([stringProp])
				)
			).toBe('Company equals "Acme"');
		});

		it('omits value rendering for value-less operators', () => {
			expect(
				contactPropertyEditorModule.getDescription(
					{ kind: 'contact_property', field: 'company', operator: 'is_empty', value: '' },
					makeCtx([stringProp])
				)
			).toBe('Company is empty');
		});
	});
});
