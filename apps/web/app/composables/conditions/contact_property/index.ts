import { defineAsyncComponent } from 'vue';
import type { Doc } from '@owlat/api/dataModel';
import type {
	ConditionEditorContext,
	ConditionEditorModule,
	ConditionOfKind,
	LocalizedText,
} from '../types';

type ContactPropertyOperator = ConditionOfKind<'contact_property'>['operator'];

interface OperatorOption {
	value: ContactPropertyOperator;
	/** i18n message key — resolve with `t()` at render time. */
	label: string;
}

/** Message-key root for this module; see `i18n/locales/en.json`. */
const K = 'shared.conditions.contact_property';

const STRING_OPERATORS: OperatorOption[] = [
	{ value: 'equals', label: `${K}.operators.equals` },
	{ value: 'not_equals', label: `${K}.operators.not_equals` },
	{ value: 'contains', label: `${K}.operators.contains` },
	{ value: 'not_contains', label: `${K}.operators.not_contains` },
	{ value: 'is_empty', label: `${K}.operators.is_empty` },
	{ value: 'not_empty', label: `${K}.operators.not_empty` },
];

const NUMBER_OPERATORS: OperatorOption[] = [
	{ value: 'equals', label: `${K}.operators.equals` },
	{ value: 'not_equals', label: `${K}.operators.not_equals` },
	{ value: 'gt', label: `${K}.operators.gt` },
	{ value: 'lt', label: `${K}.operators.lt` },
	{ value: 'gte', label: `${K}.operators.gte` },
	{ value: 'lte', label: `${K}.operators.lte` },
	{ value: 'is_empty', label: `${K}.operators.is_empty` },
	{ value: 'not_empty', label: `${K}.operators.not_empty` },
];

const BOOLEAN_OPERATORS: OperatorOption[] = [
	{ value: 'is_true', label: `${K}.operators.is_true` },
	{ value: 'is_false', label: `${K}.operators.is_false` },
];

const BUILT_IN_FIELDS: { value: string; label: string; type: 'string' }[] = [
	{ value: 'email', label: `${K}.fields.email`, type: 'string' },
	{ value: 'firstName', label: `${K}.fields.firstName`, type: 'string' },
	{ value: 'lastName', label: `${K}.fields.lastName`, type: 'string' },
	{ value: 'source', label: `${K}.fields.source`, type: 'string' },
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

/**
 * A built-in field's name is chrome, not data, so it has to be translated —
 * and a translated noun cannot be handed to `t()` as a plain interpolation
 * param. The whole sentence therefore lives under its own key per built-in
 * field; a custom property keeps the generic sentence, with the workspace's own
 * (untranslatable) property label interpolated.
 */
const BUILT_IN_DESCRIBABLE_OPERATORS = new Set<ContactPropertyOperator>([
	'equals',
	'not_equals',
	'contains',
	'not_contains',
	'is_empty',
	'not_empty',
]);

function fieldLabel(field: string, contactProperties: Doc<'contactProperties'>[]): string {
	const property = contactProperties.find((p) => p.key === field);
	return property?.label ?? field;
}

export const contactPropertyEditorModule: ConditionEditorModule<'contact_property'> = {
	kind: 'contact_property',
	label: `${K}.label`,
	description: `${K}.description`,
	createDefault: () => ({
		kind: 'contact_property',
		field: '',
		operator: 'equals',
		value: '',
	}),
	validateForSubmit(condition) {
		if (!condition.field) return `${K}.validation.fieldRequired`;
		if (operatorNeedsValue(condition.operator)) {
			const value = condition.value;
			if (value === undefined || value === null || value === '') {
				return `${K}.validation.valueRequired`;
			}
		}
		return null;
	},
	getDescription(condition, ctx: ConditionEditorContext): LocalizedText {
		if (!condition.field) return { key: `${K}.descriptions.empty` };
		const valueParams: Record<string, string> = operatorNeedsValue(condition.operator)
			? { value: String(condition.value ?? '') }
			: {};
		const builtIn = BUILT_IN_FIELDS.find((f) => f.value === condition.field);
		if (builtIn && BUILT_IN_DESCRIBABLE_OPERATORS.has(condition.operator)) {
			return {
				key: `${K}.builtInDescriptions.${builtIn.value}.${condition.operator}`,
				params: valueParams,
			};
		}
		return {
			key: `${K}.descriptions.${condition.operator}`,
			params: {
				field: fieldLabel(condition.field, ctx.contactProperties.value),
				...valueParams,
			},
		};
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../components/conditions/contact_property/Editor.vue')
	),
};
