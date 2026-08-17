import { defineAsyncComponent } from 'vue';
import type { ConditionEditorModule, ConditionOfKind, LocalizedText } from '../types';

type EmailActivityCondition = ConditionOfKind<'email_activity'>;

interface ActivityOption {
	field: EmailActivityCondition['field'];
	operator: EmailActivityCondition['operator'];
	/** i18n message key — resolve with `t()` at render time. */
	label: string;
}

/** Message-key root for this module; see `i18n/locales/en.json`. */
const K = 'shared.conditions.email_activity';

export const ACTIVITY_OPTIONS: ActivityOption[] = [
	{ field: 'opened', operator: 'is_true', label: `${K}.options.opened_is_true` },
	{ field: 'clicked', operator: 'is_true', label: `${K}.options.clicked_is_true` },
	{ field: 'opened', operator: 'is_false', label: `${K}.options.opened_is_false` },
	{ field: 'clicked', operator: 'is_false', label: `${K}.options.clicked_is_false` },
];

export function activityKey(c: EmailActivityCondition): string {
	return `${c.field}:${c.operator}`;
}

export const emailActivityEditorModule: ConditionEditorModule<'email_activity'> = {
	kind: 'email_activity',
	label: `${K}.label`,
	description: `${K}.description`,
	createDefault: () => ({
		kind: 'email_activity',
		field: 'opened',
		operator: 'is_true',
	}),
	validateForSubmit(condition) {
		if (condition.field !== 'opened' && condition.field !== 'clicked') {
			return `${K}.validation.activityRequired`;
		}
		return null;
	},
	getDescription(condition): LocalizedText {
		const match = ACTIVITY_OPTIONS.find(
			(o) => o.field === condition.field && o.operator === condition.operator
		);
		return { key: match?.label ?? `${K}.descriptions.fallback` };
	},
	EditorComponent: defineAsyncComponent(
		() => import('../../../components/conditions/email_activity/Editor.vue')
	),
};
