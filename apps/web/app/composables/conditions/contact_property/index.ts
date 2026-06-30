import { defineAsyncComponent } from 'vue';
import type { Doc } from '@owlat/api/dataModel';
import type {
	ConditionEditorContext,
	ConditionEditorModule,
	ConditionOfKind,
} from '../types';

type ContactPropertyOperator = ConditionOfKind<'contact_property'>['operator'];

interface OperatorOption {
	value: ContactPropertyOperator;
	label: string;
}

const STRING_OPERATORS: OperatorOption[] = [
	{ value: 'equals', label: 'Equals' },
	{ value: 'not_equals', label: 'Does not equal' },
	{ value: 'contains', label: 'Contains' },
	{ value: 'not_contains', label: 'Does not contain' },
	{ value: 'is_empty', label: 'Is empty' },
	{ value: 'not_empty', label: 'Is not empty' },
];

const NUMBER_OPERATORS: OperatorOption[] = [
	{ value: 'equals', label: 'Equals' },
	{ value: 'not_equals', label: 'Does not equal' },
	{ value: 'gt', label: 'Greater than' },
	{ value: 'lt', label: 'Less than' },
	{ value: 'gte', label: 'Greater than or equal' },
	{ value: 'lte', label: 'Less than or equal' },
	{ value: 'is_empty', label: 'Is empty' },
	{ value: 'not_empty', label: 'Is not empty' },
];

const BOOLEAN_OPERATORS: OperatorOption[] = [
	{ value: 'is_true', label: 'Is true' },
	{ value: 'is_false', label: 'Is false' },
];

const BUILT_IN_FIELDS: { value: string; label: string; type: 'string' }[] = [
	{ value: 'email', label: 'Email', type: 'string' },
	{ value: 'firstName', label: 'First Name', type: 'string' },
	{ value: 'lastName', label: 'Last Name', type: 'string' },
	{ value: 'source', label: 'Source', type: 'string' },
];

const VALUE_LESS_OPERATORS = new Set<ContactPropertyOperator>([
	'is_empty',
	'not_empty',
	'is_true',
	'is_false',
]);

function resolveFieldType(
	field: string,
	contactProperties: Doc<'contactProperties'>[]
): 'string' | 'number' | 'boolean' {
	const builtIn = BUILT_IN_FIELDS.find((f) => f.value === field);
	if (builtIn) return builtIn.type;
	const property = contactProperties.find((p) => p.key === field);
	if (property?.type === 'number') return 'number';
	if (property?.type === 'boolean') return 'boolean';
	return 'string';
}

export function operatorsForField(
	field: string,
	contactProperties: Doc<'contactProperties'>[]
): OperatorOption[] {
	if (!field) return STRING_OPERATORS;
	const type = resolveFieldType(field, contactProperties);
	if (type === 'number') return NUMBER_OPERATORS;
	if (type === 'boolean') return BOOLEAN_OPERATORS;
	return STRING_OPERATORS;
}

export function operatorNeedsValue(operator: ContactPropertyOperator): boolean {
	return !VALUE_LESS_OPERATORS.has(operator);
}

export { BUILT_IN_FIELDS };

const OPERATOR_DESCRIPTIONS: Record<ContactPropertyOperator, string> = {
	equals: 'equals',
	not_equals: 'does not equal',
	contains: 'contains',
	not_contains: 'does not contain',
	gt: '>',
	lt: '<',
	gte: '>=',
	lte: '<=',
	is_empty: 'is empty',
	not_empty: 'is set',
	is_true: 'is true',
	is_false: 'is false',
};

function fieldLabel(field: string, contactProperties: Doc<'contactProperties'>[]): string {
	const builtIn = BUILT_IN_FIELDS.find((f) => f.value === field);
	if (builtIn) return builtIn.label;
	const property = contactProperties.find((p) => p.key === field);
	return property?.label ?? field;
}

export const contactPropertyEditorModule: ConditionEditorModule<'contact_property'> = {
	kind: 'contact_property',
	label: 'Contact Property',
	description: 'Filter by contact field or custom property',
	createDefault: () => ({
		kind: 'contact_property',
		field: '',
		operator: 'equals',
		value: '',
	}),
	validateForSubmit(condition) {
		if (!condition.field) return 'Please select a property';
		if (operatorNeedsValue(condition.operator)) {
			const value = condition.value;
			if (value === undefined || value === null || value === '') {
				return 'Please enter a value';
			}
		}
		return null;
	},
	getDescription(condition, ctx: ConditionEditorContext) {
		if (!condition.field) return 'Select a property';
		const label = fieldLabel(condition.field, ctx.contactProperties.value);
		const opLabel = OPERATOR_DESCRIPTIONS[condition.operator] ?? condition.operator;
		if (!operatorNeedsValue(condition.operator)) {
			return `${label} ${opLabel}`;
		}
		return `${label} ${opLabel} "${condition.value ?? ''}"`;
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../components/conditions/contact_property/Editor.vue')
	),
};
